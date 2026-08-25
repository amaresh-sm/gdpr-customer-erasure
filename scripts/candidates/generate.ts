import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

type Provider = 'codex-login' | 'portkey';

interface GenerationStatus {
  state?: string;
  Running?: boolean;
  GenerationComplete?: boolean;
}

interface CandidateMetadata {
  run: { status: 'completed' | 'failed' | 'timed_out' };
}

const root = resolve(process.cwd());
const providerIndex = process.argv.indexOf('--provider');
const provider = process.argv[providerIndex + 1] as Provider | undefined;

function help(): void {
  process.stdout.write(`Usage:\n\n  npm run candidates:generate:codex -- --model <model> --thinking <effort> [options]\n  npm run candidates:generate:portkey -- --model <model> --thinking <effort> --portkey-env-file <private-file> [options]\n\nBoth commands create one isolated candidate run, wait for generation to end, collect trusted telemetry, clean up generation containers, and print the run directory.\n\nOptions are forwarded to candidates:run. Important options: --model, --thinking, --timeout-seconds (default 14400), --run-id, --baseline-ref, and --prompt-file.\n`);
}

async function command(program: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(program, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  return { code: code ?? 137, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

async function required(program: string, args: string[]): Promise<string> {
  const result = await command(program, args);
  if (result.code !== 0) throw new Error(`${program} failed: ${result.stderr.trim().slice(-1000)}`);
  return result.stdout;
}

function resultPath(output: string): string {
  const candidate = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!candidate || !candidate.startsWith(`${root}/candidates/`)) throw new Error('launcher did not return a candidate run directory');
  return candidate;
}

async function status(runDirectory: string): Promise<GenerationStatus> {
  const output = await required('npx', ['--prefix', 'codebase', 'tsx', 'scripts/candidates/status-container.ts', '--run-dir', runDirectory]);
  return JSON.parse(output) as GenerationStatus;
}

async function waitForGeneration(runDirectory: string): Promise<void> {
  for (;;) {
    const current = await status(runDirectory);
    if (current.state === 'startup_failed') throw new Error('candidate generation did not start');
    if (current.state === 'finalized' || current.Running === false || current.GenerationComplete === true) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
}

/** Runs one complete candidate-generation lifecycle without exposing scorer inputs to the model. */
async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    help();
    return;
  }
  if (provider !== 'codex-login' && provider !== 'portkey') throw new Error('this wrapper requires --provider codex-login or --provider portkey');
  const duplicateProvider = process.argv.findIndex((value, index) => value === '--provider' && index > providerIndex);
  if (duplicateProvider >= 0) throw new Error('provider is selected by the command; do not pass --provider again');
  if (provider === 'portkey' && !process.argv.includes('--portkey-env-file')) {
    throw new Error('Portkey generation requires --portkey-env-file /absolute/path/to/private-portkey.env');
  }

  const launch = await required('npx', ['--prefix', 'codebase', 'tsx', 'scripts/candidates/start-container.ts', ...process.argv.slice(2)]);
  const runDirectory = resultPath(launch);
  process.stdout.write(`Generation started: ${runDirectory}\n`);
  await waitForGeneration(runDirectory);
  const finalized = await required('npx', ['--prefix', 'codebase', 'tsx', 'scripts/candidates/finalize-container.ts', '--run-dir', runDirectory]);
  const metadataPath = finalized.trim();
  const metadata = JSON.parse(await readFile(join(runDirectory, 'metadata.json'), 'utf8')) as CandidateMetadata;
  process.stdout.write(`Generation finalized: ${runDirectory}\nTelemetry: ${metadataPath}\nNext: npm run candidates:score -- ${runDirectory}\n`);
  if (metadata.run.status !== 'completed') process.exitCode = 1;
}

await main();
