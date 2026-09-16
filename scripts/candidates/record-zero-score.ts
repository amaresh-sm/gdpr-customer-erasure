import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CandidateRunManifest, CandidateScoring } from './types.js';
import { sourceState } from './source-state.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

/** Records zero when no implementation differs from the supplied baseline. */
async function main(): Promise<void> {
  const runDirectory = resolve(argument('--run-dir'));
  const state = await sourceState(runDirectory, resolve(argument('--baseline-dir')));
  if (state.changed) throw new Error('candidate source differs from the baseline; use the normal verifier scorer');
  const metadataPath = join(runDirectory, 'metadata.json');
  const manifest = JSON.parse(await readFile(metadataPath, 'utf8')) as CandidateRunManifest;
  manifest.source.baseline_sha256 = state.baseline_sha256;
  manifest.source.sha256 = state.source_sha256;
  manifest.source.changed = false;

  const reportDirectory = join(runDirectory, 'reports');
  const scorePath = join(reportDirectory, 'hidden.score.json');
  const junitPath = join(reportDirectory, 'hidden.junit.xml');
  const evidence = 'Candidate source matches the baseline; hidden verifier was not run.';
  const score = {
    schema_version: 1, state: 'complete', earned: 0, maximum: 1, evaluated_maximum: 1,
    unverified_maximum: 0, hard_pass: false, comparable: false,
    checks: [{ id: 'candidate.no_source_changes', label: 'candidate source differs from baseline', state: 'fail', earned: 0, maximum: 1, evidence }],
  };
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="candidate-generation" tests="1" failures="1">\n  <testcase name="candidate source differs from baseline">\n    <failure message="${evidence}"/>\n  </testcase>\n</testsuite>\n`;
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`);
  await writeFile(junitPath, junit);
  const scoring: CandidateScoring = {
    verifier_ref: argument('--verifier-ref'), junit_path: 'reports/hidden.junit.xml', score_path: 'reports/hidden.score.json',
    scenarios_total: 1, scenarios_passed: 0, score: 0, score_maximum: 1, hard_pass: false, score_state: 'complete',
    report_sha256: createHash('sha256').update(junit).digest('hex'), evaluated_maximum: 1, comparable: false, reason: 'no_candidate_changes',
  };
  manifest.scoring = scoring;
  await writeFile(metadataPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
