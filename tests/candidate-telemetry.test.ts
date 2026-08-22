import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCodexJsonl } from '../scripts/candidates/telemetry.js';

test('candidate telemetry records token totals, redacted tool trajectory, and terminal evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'candidate-telemetry-'));
  const events = [
    { timestamp: '2026-08-22T10:00:00.000Z', type: 'session_meta', payload: { session_id: 'thread-123' } },
    { timestamp: '2026-08-22T10:00:01.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo test', api_key: 'secret-value' }) } },
    { timestamp: '2026-08-22T10:00:03.500Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: { exit_code: 0, output: 'ok' } } },
    { timestamp: '2026-08-22T10:00:04.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 120 } } } },
    { timestamp: '2026-08-22T10:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  const path = join(directory, 'events.jsonl');
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\nnot-json\n`);

  const telemetry = await parseCodexJsonl(path);

  assert.equal(telemetry.threadId, 'thread-123');
  assert.equal(telemetry.eventCount, 5);
  assert.equal(telemetry.invalidEventCount, 1);
  assert.equal(telemetry.terminalEvent, 'task_complete');
  assert.deepEqual(telemetry.tokens, { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 120 });
  assert.equal(telemetry.toolCalls.length, 1);
  assert.equal(telemetry.toolCalls[0]?.category, 'shell');
  assert.equal(telemetry.toolCalls[0]?.duration_ms, 2_500);
  assert.deepEqual(telemetry.toolCalls[0]?.sanitized_arguments, { cmd: 'echo test', api_key: '[REDACTED]' });
});
