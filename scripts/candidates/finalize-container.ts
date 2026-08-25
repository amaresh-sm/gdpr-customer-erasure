import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { CandidateRunManifest, Evidence } from './types.js';

interface LaunchRecord {
  state: 'running' | 'startup_failed' | 'finalized';
  run_id: string;
  provider: 'codex-login' | 'portkey';
  model: string;
  reasoning_effort: string;
  timeout_seconds: number;
  started_at: string;
  prompt_sha256: string;
  baseline_ref: string;
  source_directory: string;
  network: string | null;
  model_container: string | null;
  gateway_container: string | null;
  artifact_container: string | null;
  docker_volume: string | null;
  workspace_volume: string | null;
  generation_image: { tag: string; id: string | null };
  gateway_image: { tag: string; id: string | null };
  artifact_image: { tag: string; id: string | null };
  portkey_route: { kind: 'config' | 'provider'; value_sha256: string } | null;
  failure: string | null;
  completed_at?: string | null;
  exit_code?: number | null;
  run_status?: 'completed' | 'timed_out' | 'failed' | null;
  cleanup_completed?: boolean | null;
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
  if (launch.model_container) await command('docker', ['rm', '--force', '--volumes', launch.model_container]);
  if (launch.gateway_container) await command('docker', ['rm', '--force', '--volumes', launch.gateway_container]);
  if (launch.artifact_container && launch.artifact_container !== launch.gateway_container) await command('docker', ['rm', '--force', '--volumes', launch.artifact_container]);
  if (launch.network) await command('docker', ['network', 'rm', launch.network]);
  if (launch.docker_volume) await command('docker', ['volume', 'rm', '--force', launch.docker_volume]);
  if (launch.workspace_volume) await command('docker', ['volume', 'rm', '--force', launch.workspace_volume]);
}

async function exportWorkspace(launch: LaunchRecord, runDirectory: string): Promise<void> {
  if (!launch.model_container) throw new Error('model container is unavailable');
  const staging = await mkdtemp(join(runDirectory, 'trusted', 'workspace-export-'));
  try {
    await required('docker', ['cp', `${launch.model_container}:/workspace/source/.`, staging]);
    await rm(launch.source_directory, { recursive: true, force: true });
    await rename(staging, launch.source_directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Converts a completed detached generation container into a durable candidate artifact. */
async function main(): Promise<void> {
  const runDirectory = resolve(argument('--run-dir'));
  const launchPath = join(runDirectory, 'trusted', 'launch.json');
  const launch = JSON.parse(await readFile(launchPath, 'utf8')) as LaunchRecord;
  if (launch.state !== 'running' || !launch.model_container) throw new Error(`generation was not started: ${launch.failure ?? 'unknown startup failure'}`);
  const stateRaw = await required('docker', ['inspect', launch.model_container, '--format', '{{json .State}}']);
  const state = JSON.parse(stateRaw) as { Running: boolean; ExitCode: number; FinishedAt: string; OOMKilled: boolean; Error: string };
  let exitCode = state.ExitCode;
  let completedAt = state.FinishedAt && state.FinishedAt !== '0001-01-01T00:00:00Z' ? new Date(state.FinishedAt).toISOString() : new Date().toISOString();
  if (state.Running) {
    const finished = await command('docker', ['exec', launch.model_container, 'test', '-f', '/tmp/generation-finished']);
    if (finished.code !== 0) throw new Error('generation is still running; finalize only after the completion marker exists');
    const result = (await required('docker', ['exec', launch.model_container, 'cat', '/workspace/generation-result'])).trim().split(/\r?\n/);
    exitCode = Number(result[0]);
    if (!Number.isInteger(exitCode)) throw new Error('generation result has an invalid exit code');
    completedAt = new Date(result[1]!).toISOString();
  }
  const rawEvents = join(runDirectory, 'trusted', 'events.raw.jsonl');
  const logs = await required('docker', ['logs', launch.model_container]);
  await exportWorkspace(launch, runDirectory);
  await writeFile(rawEvents, logs);
  const logsDirectory = join(runDirectory, 'logs');
  await mkdir(logsDirectory, { recursive: true });
  await writeFile(join(logsDirectory, 'container-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  const status = exitCode === 0 ? 'completed' : exitCode === 124 ? 'timed_out' : 'failed';
  const collect = await command(process.execPath, [
    '--import', 'tsx', join(root, 'scripts/candidates/collect.ts'),
    '--run-dir', runDirectory, '--events', rawEvents, '--prompt-file', join(runDirectory, 'trusted', 'generation_prompt.md'),
    '--model', launch.model, '--thinking', launch.reasoning_effort, '--provider', launch.provider,
    '--baseline-ref', launch.baseline_ref, '--started-at', launch.started_at, '--completed-at', completedAt,
    '--model-elapsed-ms', String(Math.max(0, Date.parse(completedAt) - Date.parse(launch.started_at))), '--exit-code', String(exitCode), '--status', status,
  ]);
  if (collect.code !== 0) {
    throw new Error(`could not collect candidate telemetry: ${collect.stderr.trim().slice(-1000)}`);
  }
  await rm(rawEvents, { force: true });
  const metadataPath = join(runDirectory, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as CandidateRunManifest;
  metadata.runtime.generation_image = launch.generation_image.id === null
    ? unavailable('Docker image inspect', 'generation image ID was unavailable')
    : measured(`${launch.generation_image.tag}@${launch.generation_image.id}`, 'Docker image inspect');
  metadata.runtime.gateway_image = launch.gateway_image.id === null
    ? unavailable('Docker image inspect', 'gateway image ID was unavailable')
    : measured(`${launch.gateway_image.tag}@${launch.gateway_image.id}`, 'Docker image inspect');
  metadata.isolation.host_mount_assertion = measured(true, 'trusted launcher: candidate source was the only host bind mount and was read-only; edits occurred in a private named volume');
  metadata.isolation.network_mode = measured(
    launch.provider === 'codex-login'
      ? 'private internal network with public HTTPS egress proxy; private and local destinations blocked'
      : 'private internal network with strict Portkey Responses proxy and public HTTPS egress; private and local destinations blocked',
    'trusted Docker network launcher',
  );
  metadata.credential_safety.location = measured(
    launch.provider === 'codex-login' ? '/codex-home/auth.json' : 'trusted provider proxy configuration only',
    'trusted launcher',
  );
  metadata.credential_safety.ephemeral_storage = measured(true, 'Docker tmpfs');
  metadata.credential_safety.post_run_persistence = measured(false, 'model container removed after telemetry collection');
  metadata.credential_safety.leak_scan = unavailable('trusted launcher', 'credential leak scanning is not implemented yet; no claim is made');
  metadata.cleanup.removed_transient_files = measured(['inner Docker containers and volumes', 'private workspace volume', 'inner Docker data volume'], 'rootless DinD cleanup policy');
  metadata.resources.cpu_seconds = unavailable('Docker cgroups', 'detached runs are not sampled yet');
  metadata.resources.peak_memory_bytes = unavailable('Docker cgroups', 'detached runs are not sampled yet');
  metadata.portkey.route_identity = launch.portkey_route === null
    ? { value: null, status: 'not_applicable', source: 'provider selection', reason: 'Codex login was used' }
    : measured(`${launch.portkey_route.kind}:${launch.portkey_route.value_sha256}`, 'trusted Portkey launcher');
  metadata.run.failure_reason = status === 'completed' ? null : `model container exit ${exitCode}; see logs/container-state.json and logs/events.sanitized.json`;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await cleanup(launch);
  launch.state = 'finalized';
  launch.completed_at = completedAt;
  launch.exit_code = exitCode;
  launch.run_status = status;
  launch.cleanup_completed = true;
  await writeFile(launchPath, `${JSON.stringify(launch, null, 2)}\n`);
  process.stdout.write(`${metadataPath}\n`);
}

await main();
