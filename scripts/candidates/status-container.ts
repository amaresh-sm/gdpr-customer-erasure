import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

const runDirectory = resolve(argument('--run-dir'));
const launch = JSON.parse(await readFile(join(runDirectory, 'trusted', 'launch.json'), 'utf8')) as { state: string; model_container: string | null; failure: string | null };
if (launch.state !== 'running' || !launch.model_container) {
  process.stdout.write(`${JSON.stringify({ state: launch.state, failure: launch.failure })}\n`);
  process.exitCode = 1;
} else {
  const child = spawn('docker', ['inspect', launch.model_container, '--format', '{{json .State}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error('generation container is unavailable; it may already have been finalized');
  process.stdout.write(`${JSON.stringify(JSON.parse(Buffer.concat(output).toString('utf8')), null, 2)}\n`);
}
