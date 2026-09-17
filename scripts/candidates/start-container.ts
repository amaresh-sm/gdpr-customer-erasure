import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { treeSha256 } from './source-state.js';

interface LaunchRecord {
  schema_version: 1;
  state: 'running' | 'startup_failed' | 'finalized';
  run_id: string;
  provider: 'openhands';
  model: string;
  reasoning_effort: string;
  timeout_seconds: number;
  started_at: string;
  prompt_sha256: string;
  baseline_ref: string;
  baseline_source_sha256: string;
  source_directory: string;
  network: string | null;
  model_container: string | null;
  docker_volume: string | null;
  workspace_volume: string | null;
  generation_image: { tag: string; id: string | null };
  gateway_image: { tag: string; id: string | null } | null;
  failure: string | null;
  completed_at?: string | null;
  exit_code?: number | null;
  run_status?: 'completed' | 'timed_out' | 'failed' | null;
  cleanup_completed?: boolean | null;
}

const root = resolve(process.cwd());
const candidateRoot = join(root, 'benchmarking-candidates');
// Bump the generation image when the staged reusable gateway changes so a
// previously built image cannot silently hide a newer gateway revision.
const generationImage = 'payflow-candidate-generation-rootless:v22';
const innerImages = [
  'node:22-bookworm-slim',
  'postgres:16-alpine',
  'redis:7.4-alpine',
  'redpandadata/redpanda:v24.3.6',
  'quay.io/minio/minio:RELEASE.2025-02-28T09-55-16Z',
  'opensearchproject/opensearch:2.18.0',
  'axllent/mailpit:v1.24.1',
] as const;

function value(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const result = index < 0 ? fallback : process.argv[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${name}`);
  return result;
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function runId(model: string, reasoning: string): string {
  const normalized = `${model}-${reasoning}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '');
  return `${normalized}-${new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z').toLowerCase()}`;
}

async function command(program: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(program, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  return { code: code ?? 137, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

async function required(program: string, args: string[], input?: string): Promise<string> {
  const result = await command(program, args, input);
  if (result.code !== 0) throw new Error(`${program} ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim().slice(-1000)}`);
  return result.stdout.trim();
}

async function imageId(tag: string): Promise<string | null> {
  const result = await command('docker', ['image', 'inspect', tag, '--format', '{{.Id}}']);
  return result.code === 0 && result.stdout.trim().startsWith('sha256:') ? result.stdout.trim() : null;
}

interface BuildContextEntry {
  source: string;
  target: string;
}

async function ensureImage(tag: string, dockerfile: string, entries: BuildContextEntry[] = []): Promise<string> {
  let id = await imageId(tag);
  if (id) return id;
  if (entries.length === 0) {
    await required('docker', ['build', '--tag', tag, '--file', dockerfile, '.']);
  } else {
    const context = await mkdtemp(join(tmpdir(), 'hackerrank-openhands-build-'));
    try {
      await mkdir(join(context, dirname(dockerfile)), { recursive: true });
      await cp(resolve(root, dockerfile), join(context, dockerfile), { recursive: false });
      for (const entry of entries) {
        await mkdir(join(context, dirname(entry.target)), { recursive: true });
        await cp(entry.source, join(context, entry.target), {
          recursive: true,
          filter: (path) => !/(^|\/)(\.env|\.venv|__pycache__|node_modules|dist|build|run-output)(\/|$)/.test(path),
        });
      }
      await required('docker', ['build', '--tag', tag, '--file', join(context, dockerfile), context]);
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  }
  id = await imageId(tag);
  if (!id) throw new Error(`Docker did not produce ${tag}`);
  return id;
}

async function copyBaseline(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    filter: (path) => !/(^|\/)(node_modules|dist|\.git|hidden_tests|reference_solution|candidates|benchmarking-candidates|calibration|internal|evaluator)(\/|$)/.test(path),
  });
}

async function requirePrivateEnvironmentFile(path: string, label = 'provider'): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size === 0 || metadata.size > 64 * 1024) {
    throw new Error(`${label} environment file must be a private, non-empty regular file`);
  }
}

const OPENHANDS_ENVIRONMENT_KEYS = new Set(['LLM_API_KEY', 'LLM_BASE_URL', 'ASTRA_GATEWAY_API_KEY', 'ASTRA_GATEWAY_BASE_URL']);

function dotenvAssignment(line: string): [string, string] | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (!match) return null;
  const key = match[1]!;
  let value = match[2]!.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  else value = value.replace(/[ \t]+#.*$/, '').trim();
  return [key, value];
}

/** Keeps only validated gateway settings while preserving no unrelated .env entries. */
function openHandsEnvironment(contents: string): string {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const assignment = dotenvAssignment(line);
    if (assignment !== null && OPENHANDS_ENVIRONMENT_KEYS.has(assignment[0])) values.set(...assignment);
  }
  if (!values.has('ASTRA_GATEWAY_API_KEY') && !values.has('LLM_API_KEY')) {
    throw new Error('OpenHands environment file must contain ASTRA_GATEWAY_API_KEY or LLM_API_KEY');
  }
  // Validate that the gateway URL (if present) is a well-formed HTTP or HTTPS URL.
  const gatewayUrl = values.get('ASTRA_GATEWAY_BASE_URL') || values.get('LLM_BASE_URL');
  if (gatewayUrl) {
    const parsed = new URL(gatewayUrl);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('Gateway base URL must be a credential-free HTTP or HTTPS URL');
    }
  }
  return `${[...values].map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

async function removeContainer(name: string | null): Promise<void> {
  if (name) await command('docker', ['rm', '--force', '--volumes', name]);
}

async function removeVolume(name: string | null): Promise<void> {
  if (name) await command('docker', ['volume', 'rm', '--force', name]);
}

async function waitForReady(container: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await command('docker', ['exec', container, 'test', '-f', '/tmp/rootless-docker-ready'])).code === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error('generation container did not become ready');
}

async function ensureInnerImages(): Promise<void> {
  for (const image of innerImages) {
    if (await imageId(image)) continue;
    await required('docker', ['pull', image]);
  }
}

/** Streams the fixed PayFlow runtime images into the private daemon without exposing the host socket. */
async function preloadInnerImages(container: string): Promise<void> {
  await ensureInnerImages();
  const save = spawn('docker', ['save', ...innerImages], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const load = spawn('docker', ['exec', '--interactive', container, 'docker', 'load'], { cwd: root, stdio: ['pipe', 'ignore', 'pipe'] });
  const saveErrors: Buffer[] = [];
  const loadErrors: Buffer[] = [];
  save.stderr.on('data', (chunk: Buffer) => saveErrors.push(chunk));
  load.stderr.on('data', (chunk: Buffer) => loadErrors.push(chunk));
  save.stdout.pipe(load.stdin);
  const [[saveCode], [loadCode]] = await Promise.all([once(save, 'close'), once(load, 'close')]) as [[number | null], [number | null]];
  if ((saveCode ?? 137) !== 0 || (loadCode ?? 137) !== 0) {
    throw new Error(`could not preload inner Docker images: ${Buffer.concat([...saveErrors, ...loadErrors]).toString('utf8').trim().slice(-1000)}`);
  }
  for (const image of innerImages) {
    await required('docker', ['exec', container, 'docker', 'image', 'inspect', image]);
  }
}

async function main(): Promise<void> {
  const requestedModel = value('--model');
  // HackerRank's OpenAI-compatible gateway expects its provider namespace for
  // OpenHands requests (for example, openai/deepseek-v4-pro). Keep the CLI
  // ergonomic while recording and executing the effective gateway model.
  //
  // LiteLLM needs this prefix purely for its own client-side provider dispatch;
  // it strips the prefix before serializing the wire request regardless. A
  // prior "bare alias" special case for minimax-m3 removed the prefix and made
  // every request fail instantly with "LLM Provider NOT provided" -- confirmed
  // by reproducing that exact failure. Every model uses the prefix.
  const model = requestedModel.includes('/') ? requestedModel : `openai/${requestedModel}`;
  const reasoning = value('--thinking');
  if (!['low', 'medium', 'high', 'xhigh', 'ultra', 'max'].includes(reasoning)) throw new Error('unsupported --thinking value');
  const timeoutSeconds = Number(value('--timeout-seconds', '14400'));
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 14400) throw new Error('--timeout-seconds must be 1..14400');
  const baselineRef = value('--baseline-ref', 'HEAD');
  const baselineDirectory = resolve(value('--codebase-dir', 'codebase'));
  const promptFile = resolve(value('--prompt-file', 'instruction/task.md'));
  const id = value('--run-id', runId(model, reasoning));
  if (!/^[a-z0-9][a-z0-9.-]{2,127}$/.test(id)) throw new Error('--run-id is unsafe');
  const runDirectory = join(candidateRoot, id);
  const sourceDirectory = join(runDirectory, 'source');
  const trustedDirectory = join(runDirectory, 'trusted');
  const launchPath = join(trustedDirectory, 'launch.json');
  const prompt = await readFile(promptFile, 'utf8');
  await mkdir(trustedDirectory, { recursive: true });
  await mkdir(join(runDirectory, 'reports'), { recursive: true });
  await writeFile(join(trustedDirectory, 'generation_prompt.md'), prompt);
  await copyBaseline(baselineDirectory, sourceDirectory);
  const baselineSourceSha256 = await treeSha256(sourceDirectory);
  // The rootless entrypoint consumes and removes this launcher-only file before the agent starts.
  // It is never present in the candidate's exported source tree.
  await writeFile(join(sourceDirectory, '.payflow-task.md'), `${prompt}\n\nWork only inside this supplied codebase. Implement the task, then run the public checks that are available locally.\n`);

  const suffix = randomUUID().replaceAll('-', '');
  const network = `payflow-generation-${suffix}`;
  const modelContainer = `payflow-model-${suffix}`;
  const dockerVolume = `payflow-inner-docker-${suffix}`;
  const workspaceVolume = `payflow-workspace-${suffix}`;
  const startedAt = new Date().toISOString();
  let modelName: string | null = null;
  let generationId: string | null = null;
  let failure: string | null = null;
  let openhandsEnvironment: string | null = null;
  try {
    generationId = await ensureImage(generationImage, 'docker/candidate-generation/rootless-dind.Dockerfile', [
      {
        source: resolve(root, '../../hackerrank-openhands-gateway'),
        target: 'hackerrank-openhands-gateway',
      },
      {
        source: resolve(root, 'docker/candidate-generation/rootless-dind-entrypoint.sh'),
        target: 'docker/candidate-generation/rootless-dind-entrypoint.sh',
      },
    ]);
    const environmentFile = resolve(value('--openhands-env-file', resolve(root, '../../hackerrank-openhands-gateway/.env')));
    await requirePrivateEnvironmentFile(environmentFile, 'OpenHands');
    openhandsEnvironment = openHandsEnvironment(await readFile(environmentFile, 'utf8'));
    await required('docker', ['network', 'create', network]);
    await required('docker', ['volume', 'create', dockerVolume]);
    await required('docker', ['volume', 'create', workspaceVolume]);
    await required('docker', ['run', '--rm', '--user', 'root', '--entrypoint', 'chown', '--mount', `type=volume,src=${dockerVolume},dst=/docker-data`, generationImage, '-R', '1000:1000', '/docker-data']);
    await required('docker', ['run', '--rm', '--user', 'root', '--entrypoint', 'chown', '--mount', `type=volume,src=${workspaceVolume},dst=/workspace-data`, generationImage, '-R', '1000:1000', '/workspace-data']);
    const modelArgs = ['run', '--detach', '--name', modelContainer, '--network', network, '--privileged',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777,uid=1000,gid=1000',
      '--tmpfs', '/home/rootless/.docker/run:rw,exec,nosuid,nodev,size=64m,mode=0700,uid=1000,gid=1000',
      '--mount', `type=volume,src=${dockerVolume},dst=/home/rootless/.local/share/docker`,
      '--mount', `type=volume,src=${workspaceVolume},dst=/workspace`,
      '--pids-limit', '4096', '--memory', '10g', '--memory-swap', '10g', '--cpus', '5', '--ulimit', 'nofile=8192:8192', '--log-driver', 'local',
      '--env', 'HOME=/home/rootless', '--env', `PAYFLOW_GENERATION_PROVIDER=openhands`, '--env', `PAYFLOW_GENERATION_MODEL=${model}`, '--env', `PAYFLOW_GENERATION_REASONING_EFFORT=${reasoning}`, '--env', `PAYFLOW_GENERATION_TIMEOUT_SECONDS=${timeoutSeconds}`];
    modelArgs.push('--mount', `type=bind,src=${sourceDirectory},dst=/input,readonly`, '--workdir', '/workspace', generationImage);
    await required('docker', modelArgs);
    modelName = modelContainer;
    await waitForReady(modelContainer);
    await preloadInnerImages(modelContainer);
    await required('docker', ['exec', '-i', '--user', '1000:1000', modelContainer, 'sh', '-c', 'umask 077 && cat > /tmp/openhands.env'], openhandsEnvironment ?? '');
    await required('docker', ['exec', modelContainer, 'touch', '/tmp/generation.start']);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await removeContainer(modelName);
    await removeVolume(dockerVolume);
    await removeVolume(workspaceVolume);
    await command('docker', ['network', 'rm', network]);
  }
  const launch: LaunchRecord = {
    schema_version: 1, state: failure ? 'startup_failed' : 'running', run_id: id, provider: 'openhands', model, reasoning_effort: reasoning, timeout_seconds: timeoutSeconds,
    started_at: startedAt, prompt_sha256: sha256(prompt), baseline_ref: baselineRef, baseline_source_sha256: baselineSourceSha256, source_directory: sourceDirectory, network: failure ? null : network,
    model_container: failure ? null : modelName, docker_volume: failure ? null : dockerVolume, workspace_volume: failure ? null : workspaceVolume,
    generation_image: { tag: generationImage, id: generationId }, gateway_image: null, failure,
  };
  await writeFile(launchPath, `${JSON.stringify(launch, null, 2)}\n`);
  if (failure) throw new Error(failure);
  process.stdout.write(`${runDirectory}\n`);
}

await main();
