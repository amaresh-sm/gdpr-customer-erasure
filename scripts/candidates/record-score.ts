import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateRunManifest, CandidateScoring } from './types.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

/** Copies private scorer reports and attaches the normalized score to metadata.json. */
async function main(): Promise<void> {
  const runDirectory = argument('--run-dir');
  const junitSource = argument('--junit');
  const scoreSource = argument('--score');
  const verifierRef = argument('--verifier-ref');
  const version = process.argv.includes('--version') ? argument('--version') : 'v1';
  if (version !== 'v1' && version !== 'v2') throw new Error(`unsupported scoring version: ${version}`);
  const metadataPath = join(runDirectory, 'metadata.json');
  const report = await readFile(junitSource, 'utf8');
  const match = /<testsuite[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"/.exec(report);
  if (!match) throw new Error('JUnit testsuite summary was not found');
  const scenariosTotal = Number(match[1]);
  const failures = Number(match[2]);
  const score = JSON.parse(await readFile(scoreSource, 'utf8')) as {
    schema_version?: number;
    scoring_version?: string;
    state: 'complete' | 'partial' | 'blocked';
    hard_pass: boolean;
    earned: number | null;
    maximum: number;
    evaluated_maximum?: number;
    comparable?: boolean;
  };
  if (score.state !== 'complete' && score.state !== 'partial' && score.state !== 'blocked') throw new Error('score report state was invalid');
  if (version === 'v1' && score.state === 'partial') throw new Error('v1 score report cannot be partial');
  if (version === 'v2' && (score.schema_version !== 2 || score.scoring_version !== 'v2')) {
    throw new Error('v2 score report did not declare schema version 2');
  }
  if (score.state === 'complete' && (!Number.isFinite(score.earned) || !Number.isFinite(score.maximum))) {
    throw new Error('complete score report did not contain numeric score values');
  }
  if (score.maximum !== 1) throw new Error('score report maximum must be normalized to 1.0');
  if (score.state !== 'blocked' && (score.earned! < 0 || score.earned! > 1)) {
    throw new Error('numeric score report was outside the normalized 0.0–1.0 range');
  }
  const manifest = JSON.parse(await readFile(metadataPath, 'utf8')) as CandidateRunManifest;
  const suffix = version === 'v2' ? '.v2' : '';
  const target = join(runDirectory, 'reports', `hidden${suffix}.junit.xml`);
  const scoreTarget = join(runDirectory, 'reports', `hidden${suffix}.score.json`);
  await copyFile(junitSource, target);
  await copyFile(scoreSource, scoreTarget);
  const scoring: CandidateScoring = {
    verifier_ref: verifierRef,
    junit_path: `reports/hidden${suffix}.junit.xml`,
    score_path: `reports/hidden${suffix}.score.json`,
    scenarios_total: scenariosTotal,
    scenarios_passed: scenariosTotal - failures,
    score: score.earned,
    score_maximum: score.maximum,
    hard_pass: score.hard_pass,
    score_state: score.state,
    report_sha256: createHash('sha256').update(report).digest('hex'),
    scoring_version: version,
    evaluated_maximum: score.evaluated_maximum ?? (score.state === 'complete' ? 1 : null),
    comparable: score.comparable ?? (score.state === 'complete'),
  };
  if (version === 'v2') manifest.scoring_v2 = scoring;
  else manifest.scoring = scoring;
  await writeFile(metadataPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
