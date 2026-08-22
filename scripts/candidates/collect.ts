import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { measured, parseCodexJsonl, unavailable } from './telemetry.js';
import type { CandidateRunManifest } from './types.js';

const execFileAsync = promisify(execFile);

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function treeSha256(root: string): Promise<string> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${relative(root, file)}\0${await sha256File(file)}\n`);
  return hash.digest('hex');
}

async function cliVersion(): Promise<string | null> {
  try {
    const result = await execFileAsync('codex', ['--version']);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitCommit(ref: string): Promise<string> {
  const result = await execFileAsync('git', ['rev-parse', ref]);
  return result.stdout.trim();
}

/** Builds metadata.json from the trusted launcher context and an ephemeral Codex JSONL transcript. */
async function main(): Promise<void> {
  const runDirectory = argument('--run-dir');
  const eventsPath = argument('--events');
  const promptPath = argument('--prompt-file');
  const model = argument('--model');
  const thinking = argument('--thinking');
  const provider = argument('--provider');
  const baselineRef = argument('--baseline-ref');
  const startedAt = argument('--started-at');
  const completedAt = argument('--completed-at');
  const modelElapsedMs = Number(argument('--model-elapsed-ms'));
  const exitCode = Number(argument('--exit-code'));
  const status = argument('--status') as CandidateRunManifest['run']['status'];
  const runId = runDirectory.split('/').filter(Boolean).at(-1);
  if (!runId || !Number.isFinite(modelElapsedMs) || !Number.isInteger(exitCode) || !['completed', 'failed', 'timed_out'].includes(status)) {
    throw new Error('invalid run collector arguments');
  }

  const telemetry = await parseCodexJsonl(eventsPath);
  const sourceDirectory = join(runDirectory, 'source');
  const promptHash = await sha256File(promptPath);
  const totalElapsed = Date.parse(completedAt) - Date.parse(startedAt);
  const byTool = Object.fromEntries(telemetry.toolCalls.reduce((counts, call) => {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()));
  const token = (name: string) => telemetry.tokens?.[name];
  const errorsDigest = createHash('sha256').update(telemetry.errorMessages.join('\n')).digest('hex');
  const version = await cliVersion();
  const manifest: CandidateRunManifest = {
    schema_version: 1,
    run: { id: runId, status, exit_code: exitCode, timeout_exceeded: status === 'timed_out', failure_reason: status === 'completed' ? null : 'see logs/codex.stderr.log and logs/final-message.md' },
    model: { provider, name: model, reasoning_effort: thinking },
    timing: {
      started_at: measured(startedAt, 'trusted launcher clock'),
      completed_at: measured(completedAt, 'trusted launcher clock'),
      generation_elapsed_ms: measured(totalElapsed, 'trusted launcher clock'),
      model_execution_elapsed_ms: measured(modelElapsedMs, 'Codex child-process wall clock'),
    },
    tokens: {
      input: token('input_tokens') === undefined ? unavailable('Codex JSONL', 'usage event absent') : measured(token('input_tokens') as number, 'Codex JSONL total_token_usage'),
      cached_input: token('cached_input_tokens') === undefined ? unavailable('Codex JSONL', 'usage event absent') : measured(token('cached_input_tokens') as number, 'Codex JSONL total_token_usage'),
      output: token('output_tokens') === undefined ? unavailable('Codex JSONL', 'usage event absent') : measured(token('output_tokens') as number, 'Codex JSONL total_token_usage'),
      reasoning: token('reasoning_output_tokens') === undefined ? unavailable('Codex JSONL', 'usage event absent') : measured(token('reasoning_output_tokens') as number, 'Codex JSONL total_token_usage'),
      total: token('total_tokens') === undefined ? unavailable('Codex JSONL', 'usage event absent') : measured(token('total_tokens') as number, 'Codex JSONL total_token_usage'),
      source: measured('Codex JSONL total_token_usage', 'Codex JSONL'),
      provider_codex_agreement: unavailable('provider proxy', 'no provider-proxy usage export was supplied'),
    },
    tool_usage: {
      total: measured(telemetry.toolCalls.length, 'Codex JSONL'),
      successful: measured(telemetry.toolCalls.filter((call) => call.status === 'ok').length, 'Codex JSONL'),
      failed: measured(telemetry.toolCalls.filter((call) => call.status === 'error').length, 'Codex JSONL'),
      cancelled: measured(telemetry.toolCalls.filter((call) => call.status === 'cancelled').length, 'Codex JSONL'),
      shell: measured(telemetry.toolCalls.filter((call) => call.category === 'shell').length, 'Codex JSONL'),
      patch: measured(telemetry.toolCalls.filter((call) => call.category === 'patch').length, 'Codex JSONL'),
      by_tool: byTool,
      trajectory: telemetry.toolCalls,
    },
    resources: {
      cpu_seconds: unavailable('Docker cgroups', 'this launcher did not run the generator inside a metered container'),
      peak_memory_bytes: unavailable('Docker cgroups', 'this launcher did not run the generator inside a metered container'),
    },
    event_integrity: {
      codex_thread_id: telemetry.threadId === null ? unavailable('Codex JSONL', 'session_meta absent') : measured(telemetry.threadId, 'Codex JSONL session_meta'),
      jsonl_event_count: measured(telemetry.eventCount, 'Codex JSONL'),
      invalid_event_count: measured(telemetry.invalidEventCount, 'Codex JSONL'),
      terminal_event: telemetry.terminalEvent === null ? unavailable('Codex JSONL', 'terminal event absent') : measured(telemetry.terminalEvent, 'Codex JSONL'),
    },
    error_integrity: { codex_error_count: measured(telemetry.errorMessages.length, 'Codex JSONL'), error_sha256: measured(errorsDigest, 'redacted Codex errors') },
    prompt_integrity: { sha256: promptHash },
    runtime: {
      codex_cli_version: version === null ? unavailable('local Codex CLI', 'codex --version failed') : measured(version, 'local Codex CLI'),
      generation_image: unavailable('Docker', 'generator was launched through local Codex CLI'),
      gateway_image: unavailable('Docker', 'no provider gateway image was supplied'),
    },
    isolation: {
      host_mount_assertion: unavailable('launcher', 'local Codex CLI has no container-mount attestation'),
      network_mode: unavailable('launcher', 'local Codex CLI has no container-network attestation'),
    },
    credential_safety: {
      location: unavailable('launcher', 'local Codex CLI authentication location is not attested'),
      ephemeral_storage: unavailable('launcher', 'no tmpfs credential attestation was supplied'),
      post_run_persistence: unavailable('launcher', 'no container lifecycle attestation was supplied'),
      leak_scan: unavailable('launcher', 'no credential scanner was supplied'),
    },
    cleanup: { removed_transient_files: unavailable('launcher', 'cleanup is not performed automatically to preserve the candidate snapshot') },
    portkey: { route_identity: unavailable('provider proxy', 'no Portkey route was configured') },
    source: { baseline_ref: baselineRef, baseline_commit: await gitCommit(baselineRef), sha256: await treeSha256(sourceDirectory) },
    scoring: { verifier_ref: null, junit_path: null, scenarios_total: null, scenarios_passed: null, report_sha256: null },
  };
  await mkdir(join(runDirectory, 'logs'), { recursive: true });
  await writeFile(join(runDirectory, 'metadata.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(runDirectory, 'logs', 'events.sanitized.json'), `${JSON.stringify({ event_count: telemetry.eventCount, invalid_event_count: telemetry.invalidEventCount, tool_trajectory: telemetry.toolCalls }, null, 2)}\n`);
}

await main();
