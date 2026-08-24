import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

type JsonRecord = Record<string, unknown>;

interface PendingCall {
  name: string;
  startedAt: string;
  arguments: unknown;
}

interface ToolCallEvidence {
  sequence: number;
  call_id: string | null;
  name: string;
  category: 'shell' | 'patch' | 'mcp' | 'other';
  started_at: string;
  duration_ms: number | null;
  status: 'ok' | 'error' | 'cancelled';
  sanitized_arguments: unknown;
  result_size_bytes: number | null;
  result_sha256: string | null;
  result_metadata: Record<string, unknown>;
  truncated: boolean | null;
}

export interface JsonlTelemetry {
  threadId: string | null;
  eventCount: number;
  invalidEventCount: number;
  terminalEvent: string | null;
  tokens: Record<string, number> | null;
  toolCalls: ToolCallEvidence[];
  errorMessages: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function timestampOf(event: JsonRecord): string {
  return typeof event.timestamp === 'string' ? event.timestamp : new Date(0).toISOString();
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

/** Removes credential values while retaining enough context to audit a tool invocation. */
export function sanitize(value: unknown, key = ''): unknown {
  if (/authorization|cookie|credential|password|secret|api[_-]?key|token/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value.replace(/\b(sk|rk|pk)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey)]));
}

function category(name: string): ToolCallEvidence['category'] {
  if (/apply_patch|patch/i.test(name)) return 'patch';
  if (/exec|shell|command|terminal/i.test(name)) return 'shell';
  if (/mcp|web__|image_gen/i.test(name)) return 'mcp';
  return 'other';
}

function durationMs(startedAt: string, endedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function outputError(output: unknown): boolean {
  return isRecord(output) && (output.isError === true || output.error !== undefined || output.status === 'error');
}

function usageFrom(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const aliases: Record<string, string> = {
    input_tokens: 'input_tokens', cached_input_tokens: 'cached_input_tokens', output_tokens: 'output_tokens',
    reasoning_output_tokens: 'reasoning_output_tokens', reasoning_tokens: 'reasoning_output_tokens', total_tokens: 'total_tokens',
  };
  const result: Record<string, number> = {};
  for (const [source, target] of Object.entries(aliases)) {
    if (typeof value[source] === 'number') result[target] = value[source] as number;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function richerUsage(current: Record<string, number> | null, candidate: Record<string, number> | null): Record<string, number> | null {
  if (!candidate) return current;
  return !current || (candidate.total_tokens ?? 0) >= (current.total_tokens ?? 0) ? candidate : current;
}

/** Parses Codex JSONL defensively for trusted local telemetry collection. */
export async function parseCodexJsonl(path: string): Promise<JsonlTelemetry> {
  const pending = new Map<string, PendingCall>();
  const calls: ToolCallEvidence[] = [];
  const errors: string[] = [];
  let eventCount = 0;
  let invalidEventCount = 0;
  let threadId: string | null = null;
  let terminalEvent: string | null = null;
  let tokens: Record<string, number> | null = null;

  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    let event: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error('event is not an object');
      event = parsed;
    } catch {
      invalidEventCount += 1;
      continue;
    }
    eventCount += 1;
    const payload = isRecord(event.payload) ? event.payload : event;
    const eventType = typeof event.type === 'string' ? event.type : '';
    const payloadType = typeof payload.type === 'string' ? payload.type : '';
    const timestamp = timestampOf(event);
    if (eventType === 'session_meta' && typeof payload.session_id === 'string') threadId = payload.session_id;
    if (typeof event.thread_id === 'string') threadId = event.thread_id;
    if (payloadType === 'task_complete' || eventType === 'turn.completed') terminalEvent = payloadType || eventType;
    const info = isRecord(payload.info) ? payload.info : undefined;
    tokens = richerUsage(tokens, usageFrom(info?.total_token_usage));
    tokens = richerUsage(tokens, usageFrom(payload.usage));
    tokens = richerUsage(tokens, usageFrom(event.usage));
    const responseType = eventType === 'response_item' ? payloadType : eventType;
    if (responseType === 'function_call' || responseType === 'tool_call') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : typeof payload.id === 'string' ? payload.id : `call-${calls.length + pending.size + 1}`;
      pending.set(callId, { name: typeof payload.name === 'string' ? payload.name : 'unknown', startedAt: timestamp, arguments: parseArguments(payload.arguments) });
    }
    if (responseType === 'function_call_output' || responseType === 'tool_result') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : typeof payload.id === 'string' ? payload.id : null;
      const pendingCall = callId ? pending.get(callId) : undefined;
      const output = payload.output ?? payload.result;
      const serialized = output === undefined ? '' : JSON.stringify(output);
      calls.push({ sequence: calls.length + 1, call_id: callId, name: pendingCall?.name ?? 'unknown', category: category(pendingCall?.name ?? 'unknown'), started_at: pendingCall?.startedAt ?? timestamp, duration_ms: pendingCall ? durationMs(pendingCall.startedAt, timestamp) : null, status: outputError(output) ? 'error' : 'ok', sanitized_arguments: sanitize(pendingCall?.arguments ?? null), result_size_bytes: Buffer.byteLength(serialized), result_sha256: sha256(serialized), result_metadata: { call_id: callId, exit_code: isRecord(output) && typeof output.exit_code === 'number' ? output.exit_code : null }, truncated: isRecord(output) && output.truncated === true });
      if (callId) pending.delete(callId);
    }
    if (/error|failed/i.test(eventType) || /error|failed/i.test(payloadType)) errors.push(sha256(JSON.stringify(sanitize(payload))));
  }
  for (const [callId, pendingCall] of pending) {
    calls.push({ sequence: calls.length + 1, call_id: callId, name: pendingCall.name, category: category(pendingCall.name), started_at: pendingCall.startedAt, duration_ms: null, status: 'cancelled', sanitized_arguments: sanitize(pendingCall.arguments), result_size_bytes: null, result_sha256: null, result_metadata: {}, truncated: null });
  }
  return { threadId, eventCount, invalidEventCount, terminalEvent, tokens, toolCalls: calls, errorMessages: errors };
}
