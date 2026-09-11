import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScoreReport, type DiagnosticCheck } from './scoring.js';

const pass: DiagnosticCheck = { id: 'api.unknown_customer', label: 'Unknown customer is tenant-safe', maximum: 0.0125, earned: 0.0125, state: 'pass' };
const fail: DiagnosticCheck = { id: 'api.concurrent_idempotency', label: 'Concurrent requests share one workflow', maximum: 0.025, earned: 0, state: 'fail', evidence: 'multiple requests' };
const blocked: DiagnosticCheck = { id: 'normal.redis', label: 'Redis is sanitized', maximum: 0.0188, earned: 0, state: 'blocked', evidence: 'full fixture unavailable' };

test('emits a comparable complete score after the full fixture is ready', () => {
  const report = buildScoreReport([pass, fail], [{ id: 'full-cross-store', state: 'ready' }], true, false);
  assert.equal(report.state, 'complete');
  assert.equal(report.comparable, true);
  assert.equal(report.earned, 0.0125);
  assert.equal(report.evaluated_maximum, 1);
});

test('awards zero to blocked checks on the single normalized scale', () => {
  const report = buildScoreReport([pass, fail, blocked], [{ id: 'full-cross-store', state: 'failed' }, { id: 'api-contract', state: 'ready' }], false, false, 'full fixture failed');
  assert.equal(report.state, 'complete');
  assert.equal(report.comparable, true);
  assert.equal(report.earned, 0.0125);
  assert.equal(report.evaluated_maximum, 1);
  assert.equal(report.unverified_maximum, 0);
  assert.deepEqual(report.diagnostics.blocked_check_ids, ['normal.redis']);
});

test('assigns a numeric zero when every check is blocked', () => {
  const report = buildScoreReport([blocked], [{ id: 'full-cross-store', state: 'failed' }], false, false);
  assert.equal(report.state, 'complete');
  assert.equal(report.comparable, true);
  assert.equal(report.earned, 0);
  assert.equal(report.evaluated_maximum, 1);
  assert.equal(report.unverified_maximum, 0);
});
