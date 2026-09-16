import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

type Provider = 'openhands';

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
  process.stdout.write(`Usage:\n\n  npm run candidates:generate:openhands -- --model <model> --thinking <effort> [--openhands-env-file <private-file>] [options]\n\nRuns the OpenHands SDK against the configured HackerRank AI gateway. Reads ASTRA_GATEWAY_API_KEY / LLM_API_KEY and optionally ASTRA_GATEWAY_BASE_URL / LLM_BASE_URL from the gateway package .env by default; --openhands-env-file overrides that location. Both HTTP and HTTPS gateway URLs are supported.\n\nCreates one isolated candidate run, waits for generation to end, collects trusted telemetry, cleans up generation containers, and prints the run directory.\n\nImportant options: --model, --thinking, --timeout-seconds (default 14400), --run-id, --baseline-ref, and --prompt-file.\n`);
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
  const allowedRoots = [`${root}/benchmarking-candidates/`, `${root}/candidates/`];
  if (!candidate || !allowedRoots.some((allowedRoot) => candidate.startsWith(allowedRoot))) throw new Error('launcher did not return a candidate run directory');
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
  if (provider !== 'openhands') throw new Error('this wrapper requires --provider openhands');
  const duplicateProvider = process.argv.findIndex((value, index) => value === '--provider' && index > providerIndex);
  if (duplicateProvider >= 0) throw new Error('provider is selected by the command; do not pass --provider again');
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
