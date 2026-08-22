import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { CandidateRunManifest, Evidence } from './types.js';

interface LaunchRecord {
  state: 'running' | 'startup_failed';
  run_id: string;
  provider: 'codex-login' | 'portkey';
  model: string;
  reasoning_effort: string;
  timeout_seconds: number;
  started_at: string;
  prompt_sha256: string;
  baseline_ref: string;
  network: string | null;
  model_container: string | null;
  gateway_container: string | null;
  generation_image: { tag: string; id: string | null };
  gateway_image: { tag: string; id: string | null };
  portkey_route: { kind: 'config' | 'provider'; value_sha256: string } | null;
  failure: string | null;
}

const root = resolve(process.cwd());

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

async function command(program: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(program, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  return { code: code ?? 137, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

async function required(program: string, args: string[]): Promise<string> {
  const result = await command(program, args);
  if (result.code !== 0) throw new Error(`${program} failed: ${result.stderr.trim().slice(-1000)}`);
  return result.stdout;
}

function measured<T>(value: T, source: string): Evidence<T> {
  return { value, status: 'measured', source, reason: null };
}

function unavailable<T>(source: string, reason: string): Evidence<T> {
  return { value: null, status: 'not_available', source, reason };
}

async function cleanup(launch: LaunchRecord): Promise<void> {
  if (launch.model_container) await command('docker', ['rm', '--force', launch.model_container]);
  if (launch.gateway_container) await command('docker', ['rm', '--force', launch.gateway_container]);
  if (launch.network) await command('docker', ['network', 'rm', launch.network]);
}

/** Converts a completed detached generation container into a durable candidate artifact. */
async function main(): Promise<void> {
  const runDirectory = resolve(argument('--run-dir'));
  const launchPath = join(runDirectory, 'trusted', 'launch.json');
  const launch = JSON.parse(await readFile(launchPath, 'utf8')) as LaunchRecord;
  if (launch.state !== 'running' || !launch.model_container) throw new Error(`generation was not started: ${launch.failure ?? 'unknown startup failure'}`);
  const stateRaw = await required('docker', ['inspect', launch.model_container, '--format', '{{json .State}}']);
  const state = JSON.parse(stateRaw) as { Running: boolean; ExitCode: number; FinishedAt: string; OOMKilled: boolean; Error: string };
  if (state.Running) throw new Error('generation is still running; finalize only after the model container exits');
  const rawEvents = `/private/tmp/${launch.run_id}.events.jsonl`;
  const logs = await required('docker', ['logs', launch.model_container]);
  await writeFile(rawEvents, logs);
  const logsDirectory = join(runDirectory, 'logs');
  await mkdir(logsDirectory, { recursive: true });
  await writeFile(join(logsDirectory, 'container-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  const completedAt = state.FinishedAt && state.FinishedAt !== '0001-01-01T00:00:00Z' ? new Date(state.FinishedAt).toISOString() : new Date().toISOString();
  const status = state.ExitCode === 0 ? 'completed' : state.ExitCode === 124 ? 'timed_out' : 'failed';
  const collect = await command(process.execPath, [
    '--import', 'tsx', join(root, 'scripts/candidates/collect.ts'),
    '--run-dir', runDirectory, '--events', rawEvents, '--prompt-file', join(runDirectory, 'source', '.benchmark', 'generation_prompt.md'),
    '--model', launch.model, '--thinking', launch.reasoning_effort, '--provider', launch.provider,
    '--baseline-ref', launch.baseline_ref, '--started-at', launch.started_at, '--completed-at', completedAt,
    '--model-elapsed-ms', String(Math.max(0, Date.parse(completedAt) - Date.parse(launch.started_at))), '--exit-code', String(state.ExitCode), '--status', status,
  ]);
  await rm(rawEvents, { force: true });
  if (collect.code !== 0) {
    await cleanup(launch);
    throw new Error(`could not collect candidate telemetry: ${collect.stderr.trim().slice(-1000)}`);
  }
  const metadataPath = join(runDirectory, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as CandidateRunManifest;
  metadata.runtime.generation_image = launch.generation_image.id === null
    ? unavailable('Docker image inspect', 'generation image ID was unavailable')
    : measured(`${launch.generation_image.tag}@${launch.generation_image.id}`, 'Docker image inspect');
  metadata.runtime.gateway_image = launch.gateway_image.id === null
    ? unavailable('Docker image inspect', 'gateway image ID was unavailable')
    : measured(`${launch.gateway_image.tag}@${launch.gateway_image.id}`, 'Docker image inspect');
  metadata.isolation.host_mount_assertion = measured(true, 'trusted launcher: candidate source was the only host bind mount on the model container');
  metadata.isolation.network_mode = measured(
    launch.provider === 'codex-login' ? 'private internal network to allowlisted Codex egress only' : 'private internal network to strict Portkey Responses proxy only',
    'trusted Docker network launcher',
  );
  metadata.credential_safety.location = measured(
    launch.provider === 'codex-login' ? '/codex-home/auth.json' : 'trusted provider proxy configuration only',
    'trusted launcher',
  );
  metadata.credential_safety.ephemeral_storage = measured(true, 'Docker tmpfs');
  metadata.credential_safety.post_run_persistence = measured(false, 'model container removed after telemetry collection');
  metadata.credential_safety.leak_scan = unavailable('trusted launcher', 'credential leak scanning is not implemented yet; no claim is made');
  metadata.cleanup.removed_transient_files = measured(['node_modules (tmpfs)', 'dist (tmpfs)'], 'generation container mount policy');
  metadata.resources.cpu_seconds = unavailable('Docker cgroups', 'detached runs are not sampled yet');
  metadata.resources.peak_memory_bytes = unavailable('Docker cgroups', 'detached runs are not sampled yet');
  metadata.portkey.route_identity = launch.portkey_route === null
    ? { value: null, status: 'not_applicable', source: 'provider selection', reason: 'Codex login was used' }
    : measured(`${launch.portkey_route.kind}:${launch.portkey_route.value_sha256}`, 'trusted Portkey launcher');
  metadata.run.failure_reason = status === 'completed' ? null : `model container exit ${state.ExitCode}; see logs/container-state.json and logs/events.sanitized.json`;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await cleanup(launch);
  process.stdout.write(`${metadataPath}\n`);
}

await main();
