import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = resolve(process.cwd());
const model = value('--model');
const effort = value('--thinking', 'high');
const environmentPath = resolve(value('--portkey-env-file'));
const suffix = randomUUID().replaceAll('-', '');
const network = `payflow-portkey-smoke-${suffix}`;
const gateway = `payflow-portkey-smoke-gateway-${suffix}`;

function value(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const result = index < 0 ? fallback : process.argv[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${name}`);
  return result;
}

async function command(program: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(program, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(input);
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  return { code: code ?? 137, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

async function required(program: string, args: string[], input?: string): Promise<string> {
  const result = await command(program, args, input);
  if (result.code !== 0) throw new Error(`${program} failed: ${result.stderr.trim().slice(-800)}`);
  return result.stdout.trim();
}

async function dotenv(path: string): Promise<Record<string, string>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error('Portkey environment file must be a private regular file');
  const values: Record<string, string> = {};
  for (const raw of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    if (!raw || raw.trimStart().startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)=([^\r\n]*?)(?:[ \t]+#.*)?$/.exec(raw);
    if (!match) throw new Error('Portkey environment file must contain only simple KEY=value entries');
    values[match[1]!] = match[2]!;
  }
  return values;
}

async function main(): Promise<void> {
  const values = await dotenv(environmentPath);
  const apiKey = values.PORTKEY_API_KEY || values.OPENAI_API_KEY;
  const baseUrl = values.PORTKEY_BASE_URL || values.OPENAI_BASE_URL || 'https://api.portkey.ai/v1';
  if (!apiKey || apiKey.length < 12) throw new Error('PORTKEY_API_KEY or OPENAI_API_KEY is required');
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('OPENAI_BASE_URL must be credential-free HTTPS');
  const upstream = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  const proxyConfig = JSON.stringify({ mode: 'portkey-openai-compatible', api_key: apiKey, upstream_url: upstream });
  const config = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { portkey: { npm: '@ai-sdk/openai-compatible', name: 'Portkey', options: { baseURL: 'http://provider-proxy:8081/v1', headers: { Authorization: 'Bearer payflow-trusted-relay' } }, models: { [model]: { name: `${model} via Portkey`, options: { reasoningEffort: effort } } } } },
    model: `portkey/${model}`,
    agent: { build: { model: `portkey/${model}`, reasoningEffort: effort } },
    permission: { bash: 'deny', edit: 'deny', write: 'deny', read: 'allow', external_directory: 'deny', webfetch: 'deny' },
  });
  try {
    await required('docker', ['network', 'create', '--internal', network]);
    await required('docker', ['run', '--detach', '--name', gateway, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m,uid=65532,gid=65532,mode=0700', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '1024m', '--memory-swap', '1024m', '--cpus', '0.5', '--log-driver', 'none', 'payflow-provider-proxy:v1']);
    await required('docker', ['network', 'connect', '--alias', 'provider-proxy', network, gateway]);
    await required('docker', ['exec', '-i', '--user', '65532:65532', gateway, 'sh', '-c', 'umask 077 && cat > /tmp/trusted-provider-config.json && touch /tmp/provider.start'], proxyConfig);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await command('docker', ['exec', '--user', '65532:65532', gateway, 'test', '-f', '/tmp/provider-route.json'])).code === 0) break;
      if (attempt === 99) throw new Error('trusted Portkey relay did not become ready');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    const output = await command('docker', ['run', '--rm', '--network', network, '--entrypoint', 'sh', '--env', 'XDG_CONFIG_HOME=/tmp/opencode/config', '--env', 'XDG_CACHE_HOME=/tmp/opencode/cache', '--env', 'XDG_DATA_HOME=/tmp/opencode/data', '--env', 'XDG_STATE_HOME=/tmp/opencode/state', '--env', 'npm_config_cache=/tmp/npm-cache', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777', 'payflow-candidate-generation-rootless:v5', '-ec', `mkdir -p /tmp/opencode/config/opencode /tmp/opencode/cache /tmp/opencode/data /tmp/opencode/state /tmp/npm-cache; printf '%s' '${config.replaceAll("'", "'\\''")}' > /tmp/opencode/config/opencode/opencode.json; opencode run --auto --dir /tmp 'Reply with exactly: smoke ok'`]);
    const evidenceResult = await command('docker', ['exec', '--user', '65532:65532', gateway, 'cat', '/tmp/portkey-direct-evidence.json']);
    if (evidenceResult.code !== 0) {
      throw new Error(`OpenCode smoke did not reach a completed Portkey response (exit ${output.code}): ${output.stderr.trim().slice(-800)}`);
    }
    const evidence = JSON.parse(evidenceResult.stdout) as Record<string, unknown>;
    process.stdout.write(`${JSON.stringify({ model, reasoning_effort: effort, exit_code: output.code, requested_model: evidence.requested_model ?? null, returned_model: evidence.returned_model ?? null, response_status: evidence.response_status ?? null, route_headers_sent: evidence.route_headers_sent ?? null, error_summary: evidence.error_summary ?? null }, null, 2)}\n`);
    if (output.code !== 0 || evidence.requested_model !== model || Number(evidence.response_status) < 200 || Number(evidence.response_status) >= 300) process.exitCode = 1;
  } finally {
    await command('docker', ['rm', '--force', '--volumes', gateway]);
    await command('docker', ['network', 'rm', network]);
  }
}

await main();
