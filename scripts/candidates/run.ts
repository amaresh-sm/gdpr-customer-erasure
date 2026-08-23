import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

interface Options {
  model: string;
  thinking: string;
  promptFile: string;
  provider: string;
  portkeyEnvFile: string | null;
  baselineRef: string;
  codebaseDirectory: string;
  timeoutSeconds: number | null;
}

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

function options(): Options {
  const requestedTimeoutSeconds = Number(option('--timeout-seconds', '900'));
  if (!Number.isInteger(requestedTimeoutSeconds) || requestedTimeoutSeconds < 0) {
    throw new Error('--timeout-seconds must be a non-negative integer (0 disables the time limit)');
  }
  const provider = option('--provider', 'codex-login');
  if (provider !== 'codex-login' && provider !== 'portkey') throw new Error('--provider must be codex-login or portkey');
  const requestedPortkeyEnvFile = process.argv.includes('--portkey-env-file') ? resolve(option('--portkey-env-file')) : null;
  if (provider === 'portkey' && requestedPortkeyEnvFile === null) throw new Error('--provider portkey requires --portkey-env-file');
  return {
    model: option('--model'),
    thinking: option('--thinking'),
    promptFile: resolve(option('--prompt-file')),
    provider,
    portkeyEnvFile: requestedPortkeyEnvFile,
    baselineRef: option('--baseline-ref', 'HEAD'),
    codebaseDirectory: resolve(option('--codebase-dir', 'codebase')),
    timeoutSeconds: requestedTimeoutSeconds === 0 ? null : requestedTimeoutSeconds,
  };
}

function timestamp(): string {
  return new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
}

function runId(model: string, thinking: string): string {
  const normalized = `${model}-${thinking}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '');
  return `${normalized}-${timestamp()}`;
}

async function exitCode(command: string, args: string[], cwd: string): Promise<void> {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`${command} failed: ${Buffer.concat(stderr).toString('utf8')}`);
}

async function command(program: string, args: string[], cwd: string, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(program, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  return { code: code ?? 137, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

async function required(program: string, args: string[], cwd: string, input?: string): Promise<string> {
  const result = await command(program, args, cwd, input);
  if (result.code !== 0) throw new Error(`${program} ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim().slice(-1000)}`);
  return result.stdout.trim();
}

async function privateDotenv(path: string): Promise<Record<string, string>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size === 0 || metadata.size > 64 * 1024) {
    throw new Error('Portkey environment file must be a private, non-empty regular file');
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

function portkeyConfiguration(fileValues: Record<string, string>): { proxyConfiguration: string; routeSha256: string } {
  const overrides = Object.fromEntries(Object.entries(process.env).filter(([key, entry]) => key.startsWith('PORTKEY_') && Boolean(entry)));
  const values = { ...fileValues, ...overrides };
  const apiKey = values.PORTKEY_API_KEY || fileValues.OPENAI_API_KEY;
  const routeValue = values.PORTKEY_CONFIG || values.PORTKEY_PROVIDER;
  if (!apiKey || apiKey.length < 12 || /\s/.test(apiKey)) throw new Error('Portkey generation requires a valid API key');
  if (Boolean(values.PORTKEY_CONFIG) === Boolean(values.PORTKEY_PROVIDER)) throw new Error('set exactly one of PORTKEY_CONFIG or PORTKEY_PROVIDER');
  if (!routeValue || routeValue.length > 512 || /[\x00-\x1f\x7f]/.test(routeValue)) throw new Error('Portkey route is invalid');
  const baseUrl = values.PORTKEY_BASE_URL || fileValues.OPENAI_BASE_URL || 'https://api.portkey.ai/v1';
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('PORTKEY_BASE_URL must be credential-free HTTPS');
  const upstream = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.pathname.endsWith('/responses') ? '' : '/responses'}${parsed.search}`;
  return {
    proxyConfiguration: JSON.stringify({ mode: 'portkey', api_key: apiKey, upstream_url: upstream, route_header: values.PORTKEY_CONFIG ? 'x-portkey-config' : 'x-portkey-provider', route_value: routeValue }),
    routeSha256: createHash('sha256').update(routeValue).digest('hex'),
  };
}

/** Starts the trusted Portkey adapter on loopback; credentials remain inside its tmpfs. */
async function startLocalPortkeyProxy(projectRoot: string, envFile: string): Promise<{ container: string; baseUrl: string; routeSha256: string }> {
  const { proxyConfiguration, routeSha256 } = portkeyConfiguration(await privateDotenv(envFile));
  const image = 'payflow-provider-proxy:v1';
  const available = await command('docker', ['image', 'inspect', image], projectRoot);
  if (available.code !== 0) await required('docker', ['build', '--tag', image, '--file', 'docker/provider-proxy/Dockerfile', '.'], projectRoot);
  const container = `payflow-local-portkey-${randomUUID()}`;
  await required('docker', ['run', '--detach', '--rm', '--name', container, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m,uid=65532,gid=65532,mode=0700', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '1024m', '--memory-swap', '1024m', '--cpus', '0.5', '--publish', '127.0.0.1::8081', '--log-driver', 'none', image], projectRoot);
  try {
    await required('docker', ['exec', '-i', '--user', '65532:65532', container, 'sh', '-c', 'umask 077 && cat > /tmp/trusted-provider-config.json && touch /tmp/provider.start'], projectRoot, proxyConfiguration);
    const mapped = await required('docker', ['port', container, '8081/tcp'], projectRoot);
    const port = /127\.0\.0\.1:(\d+)/.exec(mapped)?.[1];
    if (!port) throw new Error('Portkey proxy did not bind a loopback port');
    return { container, baseUrl: `http://127.0.0.1:${port}/v1`, routeSha256 };
  } catch (error) {
    await command('docker', ['rm', '--force', container], projectRoot);
    throw error;
  }
}

async function exportCandidate(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    filter: (path) => !/(^|\/)(node_modules|dist|\.git|hidden_tests|reference_solution|candidates|internal|evaluator)(\/|$)/.test(path),
  });
}

/** Launches an isolated candidate export through Codex and records an auditable local artifact. */
async function main(): Promise<void> {
  const config = options();
  const projectRoot = process.cwd();
  const id = runId(config.model, config.thinking);
  const runDirectory = join(projectRoot, 'candidates', id);
  const sourceDirectory = join(runDirectory, 'source');
  const logsDirectory = join(runDirectory, 'logs');
  const rawEvents = `/private/tmp/${id}.events.jsonl`;
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(join(runDirectory, 'reports'), { recursive: true });
  await mkdir(logsDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  await exportCandidate(config.codebaseDirectory, sourceDirectory);
  const executionStarted = Date.now();
  const rawOutput = createWriteStream(rawEvents, { flags: 'wx' });
  const stderr = createWriteStream(join(logsDirectory, 'codex.stderr.log'), { flags: 'wx' });
  const rawOutputClosed = once(rawOutput, 'close');
  const stderrClosed = once(stderr, 'close');
  const finalMessage = join(logsDirectory, 'final-message.md');
  const portkeyProxy = config.provider === 'portkey'
    ? await startLocalPortkeyProxy(projectRoot, config.portkeyEnvFile!)
    : null;
  const codexArgs = [
    'exec', '--json', '--ephemeral', '--model', config.model,
    '-c', `model_reasoning_effort="${config.thinking}"`,
  ];
  if (portkeyProxy) {
    codexArgs.push('-c', 'model_provider="payflow_proxy"', '-c',
      `model_providers.payflow_proxy={ name="Trusted PayFlow provider", base_url="${portkeyProxy.baseUrl}", wire_api="responses", requires_openai_auth=false, supports_websockets=false, supports_standalone_web_search=false }`);
  }
  codexArgs.push('-C', sourceDirectory, '-s', 'workspace-write', '-o', finalMessage, '--', await readFile(config.promptFile, 'utf8'));
  let timedOut = false;
  let code: number | null = 137;
  try {
    const child = spawn('codex', codexArgs, { cwd: sourceDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(rawOutput);
    child.stderr.pipe(stderr);
    const timer = config.timeoutSeconds === null
      ? null
      : setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, config.timeoutSeconds * 1_000);
    [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    if (timer !== null) clearTimeout(timer);
  } finally {
    if (portkeyProxy) await command('docker', ['rm', '--force', portkeyProxy.container], projectRoot);
  }
  await Promise.all([rawOutputClosed, stderrClosed]);
  const completedAt = new Date().toISOString();
  const status = timedOut ? 'timed_out' : code === 0 ? 'completed' : 'failed';
  await writeFile(join(logsDirectory, 'launcher.json'), `${JSON.stringify({ started_at: startedAt, completed_at: completedAt, timeout_seconds: config.timeoutSeconds, raw_event_sha256_not_retained: true,
    portkey: portkeyProxy === null ? null : { route_sha256: portkeyProxy.routeSha256, credential_storage: 'trusted loopback proxy tmpfs' } }, null, 2)}\n`);
  await exitCode(process.execPath, [
    '--import', 'tsx', join(projectRoot, 'scripts/candidates/collect.ts'),
    '--run-dir', runDirectory, '--events', rawEvents, '--prompt-file', config.promptFile,
    '--model', config.model, '--thinking', config.thinking, '--provider', config.provider,
    '--baseline-ref', config.baselineRef, '--started-at', startedAt, '--completed-at', completedAt,
    '--model-elapsed-ms', String(Date.now() - executionStarted), '--exit-code', String(code ?? 137), '--status', status,
  ], projectRoot);
  await rm(rawEvents, { force: true });
  process.stdout.write(`${runDirectory}\n`);
}

await main();
