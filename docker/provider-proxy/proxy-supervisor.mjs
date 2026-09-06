import fs from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';

const configPath = '/tmp/trusted-provider-config.json';
const deadline = Date.now() + 60_000;
while (!fs.existsSync('/tmp/provider.start')) {
  if (Date.now() >= deadline) throw new Error('trusted proxy was not configured in time');
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const rawConfig = fs.readFileSync(configPath, 'utf8');
fs.unlinkSync(configPath);
const config = JSON.parse(rawConfig);
if (typeof config.api_key !== 'string' || config.api_key.length < 12 || !['portkey', 'portkey-openai-compatible'].includes(config.mode)) {
  throw new Error('trusted provider proxy configuration is invalid');
}
if (config.mode === 'portkey' && !['x-portkey-config', 'x-portkey-provider'].includes(config.route_header)) {
  throw new Error('unsupported Portkey route header');
}

fs.writeFileSync('/tmp/provider-route.json', JSON.stringify({
  upstream_url: config.upstream_url,
  route_header: config.route_header ?? null,
  route_value: config.route_value ?? null,
  api_key: config.api_key,
}), { mode: 0o600 });
const adapterPath = config.mode === 'portkey-openai-compatible'
  ? '/usr/local/lib/portkey-openai-compatible-adapter.mjs'
  : '/usr/local/lib/portkey-adapter.mjs';
const adapter = spawn('node', [adapterPath], { stdio: 'ignore' });
for (let attempt = 0; attempt < 100; attempt += 1) {
  const ready = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 8082 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  if (ready) break;
  if (attempt === 99) throw new Error('Portkey adapter did not become ready');
  await new Promise((resolve) => setTimeout(resolve, 25));
}

const relay = spawn('socat', ['TCP-LISTEN:8081,bind=0.0.0.0,reuseaddr,fork', 'TCP:127.0.0.1:8080'], { stdio: 'ignore' });
const proxy = config.mode === 'portkey-openai-compatible'
  ? spawn('socat', ['TCP-LISTEN:8080,bind=127.0.0.1,reuseaddr,fork', 'TCP:127.0.0.1:8082'], { stdio: 'ignore' })
  : spawn('codex-responses-api-proxy', ['--port', '8080', '--upstream-url', 'http://127.0.0.1:8082/v1/responses'], { stdio: ['pipe', 'ignore', 'ignore'] });
if (config.mode === 'portkey') proxy.stdin.end(`${config.api_key}\n`);

function stop() {
  proxy.kill('SIGTERM');
  relay.kill('SIGTERM');
  adapter.kill('SIGTERM');
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
proxy.once('exit', (code) => {
  stop();
  process.exit(code ?? 1);
});
