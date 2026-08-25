import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(dashboardRoot, '..');
const candidatesRoot = path.join(projectRoot, 'candidates');
const outputPath = path.join(dashboardRoot, 'app', 'data', 'runs.json');

const value = (field) => field?.value ?? null;

function conciseCommand(command = '') {
  if (/privacy-api|privacy-and-retention/i.test(command)) return 'Read privacy requirements';
  if (/docker compose.*runtime-check/i.test(command)) return 'Run distributed runtime check';
  if (/docker compose.*seed/i.test(command)) return 'Seed the local platform';
  if (/docker compose.*up/i.test(command)) return 'Start the local platform';
  if (/npm run build/i.test(command)) return 'Build the application';
  if (/npm (test|run test)/i.test(command)) return 'Run the application tests';
  if (/npm run lint/i.test(command)) return 'Run static checks';
  if (/git diff|git status/i.test(command)) return 'Inspect candidate changes';
  if (/migration|CREATE TABLE|pg_dump|psql/i.test(command)) return 'Inspect relational data';
  if (/rg|sed|find|ls /i.test(command)) return 'Inspect repository sources';
  if (/fetch\(|curl/i.test(command)) return 'Exercise a service endpoint';
  return 'Run implementation command';
}

function mapRun(metadata, scoreReport) {
  const trajectory = (metadata.tool_usage?.trajectory ?? []).map((step) => ({
    sequence: step.sequence,
    kind: step.category ?? step.name ?? 'tool',
    state: step.status ?? 'unknown',
    label: conciseCommand(step.sanitized_arguments?.command),
    durationMs: step.duration_ms ?? null,
  }));

  return {
    id: metadata.run.id,
    status: metadata.run.status,
    exitCode: metadata.run.exit_code,
    timedOut: metadata.run.timeout_exceeded,
    provider: metadata.model.provider,
    model: metadata.model.name,
    reasoning: metadata.model.reasoning_effort,
    startedAt: value(metadata.timing?.started_at),
    completedAt: value(metadata.timing?.completed_at),
    elapsedMs: value(metadata.timing?.generation_elapsed_ms),
    tokens: {
      input: value(metadata.tokens?.input),
      cachedInput: value(metadata.tokens?.cached_input),
      output: value(metadata.tokens?.output),
      reasoning: value(metadata.tokens?.reasoning),
      total: value(metadata.tokens?.total),
    },
    tools: {
      total: value(metadata.tool_usage?.total),
      successful: value(metadata.tool_usage?.successful),
      failed: value(metadata.tool_usage?.failed),
      shell: value(metadata.tool_usage?.shell),
      patch: value(metadata.tool_usage?.patch),
      trajectory,
    },
    score: scoreReport.earned,
    scoreMaximum: scoreReport.maximum,
    hardPass: scoreReport.hard_pass,
    scoreState: scoreReport.state,
    checks: scoreReport.checks.map((check) => ({
      label: check.label,
      state: check.state,
      earned: check.earned,
      maximum: check.maximum,
    })),
  };
}

const candidates = await fs.readdir(candidatesRoot, { withFileTypes: true });
const runs = [];

for (const candidate of candidates) {
  if (!candidate.isDirectory()) continue;
  const runRoot = path.join(candidatesRoot, candidate.name);
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(runRoot, 'metadata.json'), 'utf8'));
    const score = JSON.parse(await fs.readFile(path.join(runRoot, 'reports', 'hidden.score.json'), 'utf8'));
    if (metadata.run?.status !== 'completed' || score.state !== 'complete') continue;
    runs.push(mapRun(metadata, score));
  } catch {
    // A candidate may still be running or may not have been scored yet.
  }
}

runs.sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());

await fs.writeFile(
  outputPath,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), runs: runs.slice(0, 2) }, null, 2)}\n`,
);

console.log(`Synced ${Math.min(runs.length, 2)} completed candidate runs.`);
