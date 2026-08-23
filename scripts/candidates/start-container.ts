import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

type Provider = 'codex-login' | 'portkey';

interface LaunchRecord {
  schema_version: 1;
  state: 'running' | 'startup_failed';
  run_id: string;
  provider: Provider;
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
  generation_image: { tag: string; id: string | null };
  gateway_image: { tag: string; id: string | null };
  portkey_route: { kind: 'config' | 'provider'; value_sha256: string } | null;
  failure: string | null;
}

const root = resolve(process.cwd());
const generationImage = 'payflow-candidate-generation:v1';
const egressImage = 'payflow-codex-egress:v1';
const proxyImage = 'payflow-provider-proxy:v1';

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

async function ensureImage(tag: string, dockerfile: string): Promise<string> {
  let id = await imageId(tag);
  if (id) return id;
  await required('docker', ['build', '--tag', tag, '--file', dockerfile, '.']);
  id = await imageId(tag);
  if (!id) throw new Error(`Docker did not produce ${tag}`);
  return id;
}

async function copyBaseline(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    filter: (path) => !/(^|\/)(node_modules|dist|\.git|hidden_tests|reference_solution|candidates|calibration)(\/|$)/.test(path),
  });
}

async function privateAuth(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size === 0 || metadata.size > 1024 * 1024) {
    throw new Error('Codex auth file must be a private, non-empty regular file');
  }
  const document = await readFile(path, 'utf8');
  JSON.parse(document);
  return document;
}

async function dotenv(path: string): Promise<Record<string, string>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 64 * 1024) {
    throw new Error('Portkey environment file must be a private regular file');
  }
  const values: Record<string, string> = {};
  for (const raw of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    if (!raw || raw.trimStart().startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)=([^\r\n]*?)(?:[ \t]+#.*)?$/.exec(raw);
    if (!match) throw new Error('Portkey environment file must contain only simple KEY=value entries with optional inline comments');
    values[match[1]!] = match[2]!;
  }
  return values;
}

function routeAndProxyConfiguration(fileValues: Record<string, string>): { configuration: string; route: LaunchRecord['portkey_route'] } {
  const overrides = Object.fromEntries(Object.entries(process.env).filter(([key, entry]) => key.startsWith('PORTKEY_') && Boolean(entry)));
  const values = { ...fileValues, ...overrides };
  const apiKey = values.PORTKEY_API_KEY || fileValues.OPENAI_API_KEY;
  const config = values.PORTKEY_CONFIG;
  const provider = values.PORTKEY_PROVIDER;
  if (!apiKey || apiKey.length < 12 || /\s/.test(apiKey)) throw new Error('Portkey generation requires PORTKEY_API_KEY');
  if (Boolean(config) === Boolean(provider)) throw new Error('set exactly one of PORTKEY_CONFIG or PORTKEY_PROVIDER');
  const routeValue = config ?? provider!;
  if (routeValue.length > 512 || /[\x00-\x1f\x7f]/.test(routeValue)) throw new Error('Portkey route is invalid');
  const routeHeader = config ? 'x-portkey-config' : 'x-portkey-provider';
  const baseUrl = values.PORTKEY_BASE_URL || fileValues.OPENAI_BASE_URL || 'https://api.portkey.ai/v1';
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('PORTKEY_BASE_URL must be credential-free HTTPS');
  const upstream = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.pathname.endsWith('/responses') ? '' : '/responses'}${parsed.search}`;
  return {
    configuration: JSON.stringify({ mode: 'portkey', api_key: apiKey, upstream_url: upstream, route_header: routeHeader, route_value: routeValue }),
    route: { kind: config ? 'config' : 'provider', value_sha256: sha256(routeValue) },
  };
}

async function removeContainer(name: string | null): Promise<void> {
  if (name) await command('docker', ['rm', '--force', name]);
}

async function waitForReady(container: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await command('docker', ['exec', container, 'test', '-f', '/tmp/generation-ready'])).code === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('generation container did not become ready');
}

async function main(): Promise<void> {
  const provider = value('--provider', 'codex-login') as Provider;
  if (provider !== 'codex-login' && provider !== 'portkey') throw new Error('--provider must be codex-login or portkey');
  const model = value('--model');
  const reasoning = value('--thinking');
  if (!['low', 'medium', 'high', 'xhigh', 'ultra'].includes(reasoning)) throw new Error('unsupported --thinking value');
  if (provider === 'codex-login' && !['gpt-5.6-sol', 'gpt-5.6-terra'].includes(model)) throw new Error('Codex login supports gpt-5.6-sol and gpt-5.6-terra only');
  const timeoutSeconds = Number(value('--timeout-seconds', '5400'));
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) throw new Error('--timeout-seconds must be 1..7200');
  const baselineRef = value('--baseline-ref', 'HEAD');
  const baselineDirectory = resolve(value('--codebase-dir', 'codebase'));
  const promptFile = resolve(value('--prompt-file', 'instruction/task.md'));
  const id = value('--run-id', runId(model, reasoning));
  if (!/^[a-z0-9][a-z0-9.-]{2,127}$/.test(id)) throw new Error('--run-id is unsafe');
  const runDirectory = join(root, 'candidates', id);
  const sourceDirectory = join(runDirectory, 'source');
  const trustedDirectory = join(runDirectory, 'trusted');
  const launchPath = join(trustedDirectory, 'launch.json');
  const prompt = await readFile(promptFile, 'utf8');
  await mkdir(trustedDirectory, { recursive: true });
  await mkdir(join(runDirectory, 'reports'), { recursive: true });
  await copyBaseline(baselineDirectory, sourceDirectory);
  await mkdir(join(sourceDirectory, '.benchmark'), { recursive: true });
  await writeFile(join(sourceDirectory, '.benchmark', 'generation_prompt.md'), `${prompt}\n\nWork only inside this supplied codebase. Implement the task, then run the public checks that are available locally.\n`);

  const suffix = randomUUID().replaceAll('-', '');
  const network = `payflow-generation-${suffix}`;
  const modelContainer = `payflow-model-${suffix}`;
  const gatewayContainer = `payflow-gateway-${suffix}`;
  const startedAt = new Date().toISOString();
  let gateway: string | null = null;
  let modelName: string | null = null;
  let route: LaunchRecord['portkey_route'] = null;
  let generationId: string | null = null;
  let gatewayId: string | null = null;
  let failure: string | null = null;
  let auth: string | null = null;
  let proxyConfig: string | null = null;
  try {
    generationId = await ensureImage(generationImage, 'docker/candidate-generation/Dockerfile');
    if (provider === 'codex-login') {
      gatewayId = await ensureImage(egressImage, 'docker/codex-egress/Dockerfile');
      auth = await privateAuth(resolve(value('--codex-auth-file', process.env.CODEX_AUTH_FILE ?? join(homedir(), '.codex', 'auth.json'))));
    } else {
      gatewayId = await ensureImage(proxyImage, 'docker/provider-proxy/Dockerfile');
      const environmentFile = process.argv.includes('--portkey-env-file') ? await dotenv(resolve(value('--portkey-env-file'))) : {};
      ({ configuration: proxyConfig, route } = routeAndProxyConfiguration(environmentFile));
    }
    await required('docker', ['network', 'create', '--internal', network]);
    if (provider === 'codex-login') {
      await required('docker', ['run', '--detach', '--name', gatewayContainer, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.25', '--log-driver', 'none', egressImage]);
    } else {
      await required('docker', ['run', '--detach', '--name', gatewayContainer, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m,uid=65532,gid=65532,mode=0700', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '1024m', '--memory-swap', '1024m', '--cpus', '0.5', '--log-driver', 'none', proxyImage]);
    }
    gateway = gatewayContainer;
    await required('docker', ['network', 'connect', '--alias', provider === 'codex-login' ? 'codex-egress' : 'provider-proxy', network, gatewayContainer]);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    const modelArgs = ['run', '--detach', '--name', modelContainer, '--network', network, '--read-only',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777',
      '--tmpfs', `/codex-home:rw,exec,nosuid,nodev,size=128m,mode=0700,uid=${uid},gid=${gid}`,
      '--tmpfs', '/workspace/source/node_modules:rw,exec,nosuid,nodev,size=512m,mode=1777',
      '--tmpfs', '/workspace/source/dist:rw,noexec,nosuid,nodev,size=128m,mode=1777',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '512', '--memory', '4096m', '--memory-swap', '4096m', '--cpus', '2', '--ulimit', 'nofile=1024:1024', '--log-driver', 'local', '--user', `${uid}:${gid}`,
      '--env', 'HOME=/tmp', '--env', 'CODEX_HOME=/codex-home', '--env', `BENCHMARK_PROVIDER=${provider}`, '--env', `BENCHMARK_MODEL=${model}`, '--env', `BENCHMARK_REASONING_EFFORT=${reasoning}`, '--env', `BENCHMARK_TIMEOUT_SECONDS=${timeoutSeconds}`];
    if (provider === 'codex-login') modelArgs.push('--env', 'HTTPS_PROXY=http://codex-egress:8082', '--env', 'HTTP_PROXY=http://codex-egress:8082', '--env', 'ALL_PROXY=http://codex-egress:8082', '--env', 'NO_PROXY=localhost,127.0.0.1');
    modelArgs.push('--mount', `type=bind,src=${sourceDirectory},dst=/workspace/source`, '--workdir', '/workspace/source', generationImage);
    await required('docker', modelArgs);
    modelName = modelContainer;
    await waitForReady(modelContainer);
    if (auth !== null) await required('docker', ['exec', '-i', '--user', `${uid}:${gid}`, modelContainer, 'sh', '-c', 'umask 077 && cat > /codex-home/auth.json'], auth);
    if (proxyConfig !== null) await required('docker', ['exec', '-i', '--user', '65532:65532', gatewayContainer, 'sh', '-c', 'umask 077 && cat > /tmp/trusted-provider-config.json && touch /tmp/provider.start'], proxyConfig);
    await required('docker', ['exec', modelContainer, 'touch', '/tmp/generation.start']);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await removeContainer(modelName);
    await removeContainer(gateway);
    await command('docker', ['network', 'rm', network]);
  }
  const launch: LaunchRecord = {
    schema_version: 1, state: failure ? 'startup_failed' : 'running', run_id: id, provider, model, reasoning_effort: reasoning, timeout_seconds: timeoutSeconds,
    started_at: startedAt, prompt_sha256: sha256(prompt), baseline_ref: baselineRef, source_directory: sourceDirectory, network: failure ? null : network,
    model_container: failure ? null : modelName, gateway_container: failure ? null : gateway, generation_image: { tag: generationImage, id: generationId }, gateway_image: { tag: provider === 'codex-login' ? egressImage : proxyImage, id: gatewayId }, portkey_route: route, failure,
  };
  await writeFile(launchPath, `${JSON.stringify(launch, null, 2)}\n`);
  if (failure) throw new Error(failure);
  process.stdout.write(`${runDirectory}\n`);
}

await main();
