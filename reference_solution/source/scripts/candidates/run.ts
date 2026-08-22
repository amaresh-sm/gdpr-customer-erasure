import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

interface Options {
  model: string;
  thinking: string;
  promptFile: string;
  provider: string;
  baselineRef: string;
  timeoutSeconds: number;
}

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

function options(): Options {
  const timeoutSeconds = Number(option('--timeout-seconds', '900'));
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error('--timeout-seconds must be a positive integer');
  return {
    model: option('--model'),
    thinking: option('--thinking'),
    promptFile: resolve(option('--prompt-file')),
    provider: option('--provider', 'codex-login'),
    baselineRef: option('--baseline-ref', 'question/gdpr-customer-erasure'),
    timeoutSeconds,
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

async function exportCandidate(ref: string, destination: string, cwd: string): Promise<void> {
  const archive = spawn('git', ['archive', ref], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const extract = spawn('tar', ['-x', '-C', destination], { cwd, stdio: ['pipe', 'ignore', 'pipe'] });
  archive.stdout.pipe(extract.stdin);
  const errors: Buffer[] = [];
  archive.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  extract.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  const [[archiveCode], [extractCode]] = await Promise.all([
    once(archive, 'close') as Promise<[number | null, NodeJS.Signals | null]>,
    once(extract, 'close') as Promise<[number | null, NodeJS.Signals | null]>,
  ]);
  if (archiveCode !== 0 || extractCode !== 0) throw new Error(`candidate export failed: ${Buffer.concat(errors).toString('utf8')}`);
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
  await exportCandidate(config.baselineRef, sourceDirectory, projectRoot);
  const executionStarted = Date.now();
  const rawOutput = createWriteStream(rawEvents, { flags: 'wx' });
  const stderr = createWriteStream(join(logsDirectory, 'codex.stderr.log'), { flags: 'wx' });
  const rawOutputClosed = once(rawOutput, 'close');
  const stderrClosed = once(stderr, 'close');
  const finalMessage = join(logsDirectory, 'final-message.md');
  const child = spawn('codex', [
    'exec', '--json', '--ephemeral', '--model', config.model,
    '-c', `model_reasoning_effort="${config.thinking}"`,
    '-C', sourceDirectory, '-s', 'workspace-write', '-o', finalMessage, '--',
    await (await import('node:fs/promises')).readFile(config.promptFile, 'utf8'),
  ], { cwd: sourceDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(rawOutput);
  child.stderr.pipe(stderr);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, config.timeoutSeconds * 1_000);
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);
  await Promise.all([rawOutputClosed, stderrClosed]);
  const completedAt = new Date().toISOString();
  const status = timedOut ? 'timed_out' : code === 0 ? 'completed' : 'failed';
  await writeFile(join(logsDirectory, 'launcher.json'), `${JSON.stringify({ started_at: startedAt, completed_at: completedAt, timeout_seconds: config.timeoutSeconds, raw_event_sha256_not_retained: true }, null, 2)}\n`);
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
