import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ERASURE_STEPS,
  erasureFailureCode,
  isErasureComplete,
  redactDocument,
  remainingErasureSteps,
} from '../packages/privacy/src/erasure-policy.js';

test('cleanup resumes at the first unfinished step and preserves finished work', () => {
  assert.deepEqual(remainingErasureSteps([]), [...ERASURE_STEPS]);
  const partial = remainingErasureSteps(['search_projection', 'cache_projection']);
  assert.ok(!partial.includes('search_projection'));
  assert.ok(!partial.includes('cache_projection'));
  assert.equal(partial.length, ERASURE_STEPS.length - 2);
  assert.deepEqual(remainingErasureSteps([...ERASURE_STEPS]), []);
});

test('a request completes only once every step has finished', () => {
  assert.equal(isErasureComplete([]), false);
  assert.equal(isErasureComplete(ERASURE_STEPS.slice(0, -1)), false);
  assert.equal(isErasureComplete([...ERASURE_STEPS]), true);
});

test('the last step is the profile removal that later steps would otherwise need', () => {
  assert.equal(ERASURE_STEPS.at(-1), 'customer_profile');
  assert.ok(ERASURE_STEPS.indexOf('object_storage') < ERASURE_STEPS.indexOf('customer_profile'));
  assert.ok(ERASURE_STEPS.indexOf('email_history') < ERASURE_STEPS.indexOf('customer_profile'));
});

test('reported failures are stable codes that cannot leak customer data', () => {
  assert.equal(erasureFailureCode('object_storage'), 'object_storage_failed');
  for (const step of ERASURE_STEPS) {
    assert.match(erasureFailureCode(step), /^[a-z_]+_failed$/);
  }
});

test('redaction keeps financial facts and drops personal data', () => {
  const receipt = redactDocument({
    receiptNumber: 'a5f1e0c2-0000-4000-8000-000000000001',
    amount: 2500,
    currency: 'USD',
    issuedAt: '2026-08-20T12:00:00.000Z',
    customer: { id: 'c1', email: 'ada@example.test', name: 'Ada Lovelace' },
  });
  assert.equal(receipt.amount, 2500);
  assert.equal(receipt.currency, 'USD');
  assert.equal(receipt.receiptNumber, 'a5f1e0c2-0000-4000-8000-000000000001');
  assert.deepEqual(receipt.customer, { erased: true });
  assert.ok(!JSON.stringify(receipt).includes('ada@example.test'));
  assert.ok(!JSON.stringify(receipt).includes('Ada Lovelace'));
});

test('redaction removes personal keys rather than blanking them', () => {
  const invoice = redactDocument({
    total: 5175, number: 'INV-2026-ABCD1234',
    name: 'Grace Hopper', email: 'grace@example.test', phone: '+1-212-555-0112',
    billingAddress: { line1: '1 Market Street', city: 'New York' },
  });
  assert.equal(invoice.total, 5175);
  assert.equal(invoice.number, 'INV-2026-ABCD1234');
  assert.ok(!('name' in invoice));
  assert.ok(!('email' in invoice));
  assert.ok(!('phone' in invoice));
  assert.ok(!('billingAddress' in invoice));
});

test('redaction never passes a non-object document through unchanged', () => {
  assert.deepEqual(redactDocument(null), { erased: true });
  assert.deepEqual(redactDocument('grace@example.test'), { erased: true });
  assert.deepEqual(redactDocument(['grace@example.test']), { erased: true });
});
