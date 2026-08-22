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

/** Copies the private scorer report and attaches its objective 8-scenario result to metadata.json. */
async function main(): Promise<void> {
  const runDirectory = argument('--run-dir');
  const junitSource = argument('--junit');
  const verifierRef = argument('--verifier-ref');
  const metadataPath = join(runDirectory, 'metadata.json');
  const report = await readFile(junitSource, 'utf8');
  const match = /<testsuite[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"/.exec(report);
  if (!match) throw new Error('JUnit testsuite summary was not found');
  const scenariosTotal = Number(match[1]);
  const failures = Number(match[2]);
  const manifest = JSON.parse(await readFile(metadataPath, 'utf8')) as CandidateRunManifest;
  const target = join(runDirectory, 'reports', 'hidden.junit.xml');
  await copyFile(junitSource, target);
  manifest.scoring = {
    verifier_ref: verifierRef,
    junit_path: 'reports/hidden.junit.xml',
    scenarios_total: scenariosTotal,
    scenarios_passed: scenariosTotal - failures,
    report_sha256: createHash('sha256').update(report).digest('hex'),
  };
  await writeFile(metadataPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
