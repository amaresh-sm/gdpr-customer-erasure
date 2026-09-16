import assert from 'node:assert/strict';
import test from 'node:test';
import { redactPii, retainedCustomerSnapshot } from '../packages/privacy/src/redact.js';

test('deep redaction removes identifying fields while retaining financial facts', () => {
  const redacted = redactPii({
    customerId: 'subject-id',
    customer: { email: 'person@example.com', metadata: { canary: 'secret' } },
    amount: 1250,
    currency: 'USD',
    lines: [{ description: 'Person Name', quantity: 2, total: 1250 }],
  });
  assert.deepEqual(redacted, {
    amount: 1250,
    currency: 'USD',
    lines: [{ quantity: 2, total: 1250 }],
  });
});

test('retained customer snapshots contain no stable customer identifier', () => {
  assert.deepEqual(retainedCustomerSnapshot(), { erased: true });
});
