import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateRunManifest } from './types.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

/** Copies private scorer reports and attaches binary plus weighted results to metadata.json. */
async function main(): Promise<void> {
  const runDirectory = argument('--run-dir');
  const junitSource = argument('--junit');
  const scoreSource = argument('--score');
  const verifierRef = argument('--verifier-ref');
  const metadataPath = join(runDirectory, 'metadata.json');
  const report = await readFile(junitSource, 'utf8');
  const match = /<testsuite[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"/.exec(report);
  if (!match) throw new Error('JUnit testsuite summary was not found');
  const scenariosTotal = Number(match[1]);
  const failures = Number(match[2]);
  const score = JSON.parse(await readFile(scoreSource, 'utf8')) as {
    state: 'complete' | 'blocked';
    hard_pass: boolean;
    earned: number | null;
    maximum: number;
  };
  if (score.state !== 'complete' && score.state !== 'blocked') throw new Error('score report state was invalid');
  if (score.state === 'complete' && (!Number.isFinite(score.earned) || !Number.isFinite(score.maximum))) {
    throw new Error('complete score report did not contain numeric score values');
  }
  const manifest = JSON.parse(await readFile(metadataPath, 'utf8')) as CandidateRunManifest;
  const target = join(runDirectory, 'reports', 'hidden.junit.xml');
  const scoreTarget = join(runDirectory, 'reports', 'hidden.score.json');
  await copyFile(junitSource, target);
  await copyFile(scoreSource, scoreTarget);
  manifest.scoring = {
    verifier_ref: verifierRef,
    junit_path: 'reports/hidden.junit.xml',
    score_path: 'reports/hidden.score.json',
    scenarios_total: scenariosTotal,
    scenarios_passed: scenariosTotal - failures,
    weighted_score: score.earned,
    weighted_maximum: score.maximum,
    hard_pass: score.hard_pass,
    score_state: score.state,
    report_sha256: createHash('sha256').update(report).digest('hex'),
  };
  await writeFile(metadataPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
