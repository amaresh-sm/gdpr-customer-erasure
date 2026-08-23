import { readFileSync, writeFileSync } from 'node:fs';

const [mode, scorePath, expectedCheck, outputPath] = process.argv.slice(2);

if (!mode || !scorePath || !outputPath) {
  throw new Error('usage: assert-result.mjs <reference|mutation> <score-path> <expected-check|-> <output-path>');
}

const score = JSON.parse(readFileSync(scorePath, 'utf8'));
const result = {
  mode,
  score_state: score.state,
  hard_pass: score.hard_pass,
  expected_check: expectedCheck === '-' ? null : expectedCheck,
  accepted: false,
  reason: '',
};

if (score.state !== 'complete') {
  result.reason = 'fixture did not produce a comparable score';
} else if (mode === 'reference') {
  result.accepted = score.hard_pass === true;
  result.reason = result.accepted ? 'reference passed every hidden scenario' : 'reference did not hard-pass';
} else {
  const check = score.checks.find((candidate) => candidate.id === expectedCheck);
  if (!check) {
    result.reason = `expected check ${expectedCheck} was absent`;
  } else if (check.state !== 'fail') {
    result.reason = `expected check ${expectedCheck} was ${check.state}, not fail`;
  } else {
    result.accepted = true;
    result.reason = `expected check ${expectedCheck} failed`;
  }
}

writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${result.accepted ? 'ACCEPT' : 'REJECT'}: ${result.reason}\n`);
process.exitCode = result.accepted ? 0 : 1;
