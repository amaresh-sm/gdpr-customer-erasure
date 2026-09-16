import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { classifyErasureError, ErasureStepError, erasedEmail, erasedExternalReference } from '../packages/privacy/src/redaction.js';
import { buildErasedCustomerSnapshot } from '../packages/privacy/src/snapshot.js';

test('erased identifiers are deterministic and unique per customer', () => {
  const customerId = randomUUID();
  assert.equal(erasedEmail(customerId), erasedEmail(customerId));
  assert.notEqual(erasedEmail(customerId), erasedEmail(randomUUID()));
  assert.match(erasedEmail(customerId), /^erased\+.+@erased\.payflow\.invalid$/);
  assert.equal(erasedExternalReference(customerId), `erased-${customerId}`);
});

test('erased customer snapshots never carry the original identity', () => {
  const customerId = randomUUID();
  const snapshot = buildErasedCustomerSnapshot(customerId);
  assert.equal(snapshot.id, customerId);
  assert.equal(snapshot.phone, null);
  assert.equal(snapshot.status, 'erased');
  assert.deepEqual(snapshot, buildErasedCustomerSnapshot(customerId));
});

test('erasure failures classify to stable, customer-data-free error codes', () => {
  assert.equal(classifyErasureError(new ErasureStepError('cache_unavailable', new Error('boom'))), 'cache_unavailable');
  assert.equal(classifyErasureError(new Error('someone@example.test failed')), 'erasure_processing_failed');
  assert.equal(classifyErasureError('unstructured failure'), 'erasure_processing_failed');
});
