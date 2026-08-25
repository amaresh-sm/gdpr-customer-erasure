import { access, readFile } from 'node:fs/promises';
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
const launch = JSON.parse(await readFile(join(runDirectory, 'trusted', 'launch.json'), 'utf8')) as {
  state: string;
  model_container: string | null;
  failure: string | null;
  completed_at?: string | null;
  exit_code?: number | null;
  run_status?: string | null;
  cleanup_completed?: boolean | null;
};
if (launch.state !== 'running' || !launch.model_container) {
  process.stdout.write(`${JSON.stringify({
    state: launch.state,
    failure: launch.failure,
    completed_at: launch.completed_at ?? null,
    exit_code: launch.exit_code ?? null,
    run_status: launch.run_status ?? null,
    cleanup_completed: launch.cleanup_completed ?? null,
  })}\n`);
  if (launch.state === 'startup_failed') process.exitCode = 1;
} else {
  const child = spawn('docker', ['inspect', launch.model_container, '--format', '{{json .State}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    try {
      await access(join(runDirectory, 'metadata.json'));
      process.stdout.write(`${JSON.stringify({
        state: 'finalized',
        legacy_launch_state: 'running',
        message: 'metadata exists but the launch record predates finalized-state tracking',
      })}\n`);
  } catch {
    throw new Error('generation container is unavailable before candidate metadata was written');
  }
  } else {
    const state = JSON.parse(Buffer.concat(output).toString('utf8')) as Record<string, unknown>;
    if (state.Running) {
      const marker = spawn('docker', ['exec', launch.model_container, 'test', '-f', '/tmp/generation-finished'], { stdio: 'ignore' });
      const [markerCode] = await once(marker, 'close') as [number | null, NodeJS.Signals | null];
      state.GenerationComplete = markerCode === 0;
    }
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  }
}
