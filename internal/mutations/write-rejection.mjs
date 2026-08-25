import { writeFile } from 'node:fs/promises';

const [outputPath, mode, expectedCheck, reason] = process.argv.slice(2);

if (!outputPath || !mode || !expectedCheck || !reason) {
  throw new Error('usage: write-rejection.mjs <output> <mode> <expected-check> <reason>');
}

await writeFile(outputPath, `${JSON.stringify({
  mode,
  score_state: 'infrastructure_error',
  hard_pass: false,
  expected_check: expectedCheck === '-' ? null : expectedCheck,
  accepted: false,
  reason,
}, null, 2)}\n`, 'utf8');
