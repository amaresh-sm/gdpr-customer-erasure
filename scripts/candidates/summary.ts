import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence, CandidateRunManifest } from './types.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

function value<T>(evidence: Evidence<T>, format: (item: T) => string = String): string {
  return evidence.status === 'measured' && evidence.value !== null ? format(evidence.value) : `NA (${evidence.reason ?? evidence.status})`;
}

function elapsed(milliseconds: number): string {
  return `${(milliseconds / 60_000).toFixed(2)} minutes`;
}

/** Formats the only published score scale. Legacy local artifacts are normalized on read. */
function scoreSummary(manifest: CandidateRunManifest): string {
  if (manifest.scoring.score_state === null) return 'not yet scored';
  if (manifest.scoring.score_state === 'blocked') return 'blocked — fixture did not produce a comparable score';
  const scoring = manifest.scoring as CandidateRunManifest['scoring'] & {
    weighted_score?: number | null;
    weighted_maximum?: number | null;
  };
  const earned = scoring.score ?? scoring.weighted_score;
  const maximum = scoring.score_maximum ?? scoring.weighted_maximum;
  if (earned === null || earned === undefined || maximum === null || maximum === undefined || maximum <= 0) {
    return 'not available';
  }
  return `${(earned / maximum).toFixed(4)} / 1.0000`;
}

/** States whether the score represents a complete verifier pass, independent of its magnitude. */
function verificationResult(manifest: CandidateRunManifest): string {
  if (manifest.scoring.score_state === null) return 'not yet scored';
  if (manifest.scoring.score_state === 'blocked') return 'blocked — no comparable result';
  return manifest.scoring.hard_pass ? 'hard pass' : 'not a hard pass';
}

/** Renders the comparable headline table for a locally retained candidate artifact. */
async function main(): Promise<void> {
  const runDirectory = argument('--run-dir');
  const manifest = JSON.parse(await readFile(join(runDirectory, 'metadata.json'), 'utf8')) as CandidateRunManifest;
  const rows: Array<[string, string]> = [
    ['Run ID', manifest.run.id],
    ['Provider / model / thinking', `${manifest.model.provider} / ${manifest.model.name} / ${manifest.model.reasoning_effort}`],
    ['Generation time', value(manifest.timing.generation_elapsed_ms, elapsed)],
    ['Model execution time', value(manifest.timing.model_execution_elapsed_ms, elapsed)],
    ['Input tokens', value(manifest.tokens.input)],
    ['Cached input tokens', value(manifest.tokens.cached_input)],
    ['Output tokens', value(manifest.tokens.output)],
    ['Reasoning tokens', value(manifest.tokens.reasoning)],
    ['Total tokens', value(manifest.tokens.total)],
    ['Tool calls', value(manifest.tool_usage.total)],
    ['Successful tool calls', value(manifest.tool_usage.successful)],
    ['Failed tool calls', value(manifest.tool_usage.failed)],
    ['Shell calls', value(manifest.tool_usage.shell)],
    ['Patch calls', value(manifest.tool_usage.patch)],
    ['CPU time', value(manifest.resources.cpu_seconds, (seconds) => `${seconds.toFixed(2)} seconds`)],
    ['Peak memory', value(manifest.resources.peak_memory_bytes, (bytes) => `${bytes} bytes, approximately ${(bytes / 1024 / 1024).toFixed(0)} MiB`)],
    ['Run status', `${manifest.run.status}${manifest.run.exit_code === null ? '' : ` (exit ${manifest.run.exit_code})`}`],
    ['GDPR score', scoreSummary(manifest)],
    ['Verification result', verificationResult(manifest)],
  ];
  process.stdout.write(['| Metric | Value |', '| --- | ---: |', ...rows.map(([metric, item]) => `| ${metric} | ${item} |`), ''].join('\n'));
}

await main();
