import assert from 'node:assert/strict';
import test from 'node:test';
import { isPiiKey, redactPii } from '../packages/privacy/src/redaction.js';

test('redaction removes personal data and preserves financial facts', () => {
  const receipt = {
    receiptNumber: 'b7f0c1de',
    amount: 2500,
    currency: 'USD',
    customer: { id: 'cus_1', email: 'ada@example.test', name: 'Ada Lovelace' },
    lines: [{ description: 'Subscription', quantity: 1, unitAmount: 2500, billingName: 'Ada Lovelace' }],
  };
  assert.deepEqual(redactPii(receipt), {
    receiptNumber: 'b7f0c1de',
    amount: 2500,
    currency: 'USD',
    customer: null,
    lines: [{ description: 'Subscription', quantity: 1, unitAmount: 2500, billingName: null }],
  });
});

test('redaction reaches nested and differently cased personal data keys', () => {
  assert.deepEqual(
    redactPii({ data: { customerEmail: 'grace@example.test', Phone: '+1-212-555-0112', paymentId: 'pay_1' } }),
    { data: { customerEmail: null, Phone: null, paymentId: 'pay_1' } },
  );
  assert.equal(isPiiKey('external_reference'), true);
  assert.equal(isPiiKey('amount'), false);
  assert.equal(isPiiKey('customerId'), false);
});
