import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  documentReferencesCustomer,
  redactDocument,
  redactPayload,
} from '../packages/privacy/src/redaction.js';

test('redacted event payloads keep financial facts and drop customer identity', () => {
  const customerId = randomUUID();
  const redacted = redactPayload({
    paymentId: 'pay_1', customerId, amount: 2500, currency: 'USD',
    email: 'ada@example.test', customerEmail: 'ada@example.test', name: 'Ada Lovelace',
    phone: '+1-415-555-0101', externalReference: 'crm-ada-001', metadata: { segment: 'enterprise' },
  });

  assert.deepEqual(redacted, {
    paymentId: 'pay_1', customerId, amount: 2500, currency: 'USD', customerErased: true,
  });
});

test('redaction is idempotent, so repeating a deletion converges on the same payload', () => {
  const payload = { paymentId: 'pay_1', amount: 100, email: 'ada@example.test' };
  assert.deepEqual(redactPayload(redactPayload(payload)), redactPayload(payload));
});

test('redacted documents lose nested personal data at every depth', () => {
  const redacted = redactDocument({
    receiptNumber: 'rcpt_1',
    amount: 5175,
    currency: 'USD',
    customer: { email: 'ada@example.test', name: 'Ada Lovelace' },
    lines: [{ description: 'Subscription', total: 5000, billingName: 'Ada Lovelace' }],
  });

  assert.deepEqual(redacted, {
    receiptNumber: 'rcpt_1',
    amount: 5175,
    currency: 'USD',
    lines: [{ description: 'Subscription', total: 5000 }],
  });
});

test('stored documents are recognized by customer identifier or contact address', () => {
  const customerId = randomUUID();
  const document = JSON.stringify({ customerId, contact: 'ada@example.test' });

  assert.equal(documentReferencesCustomer(document, customerId, null), true);
  assert.equal(documentReferencesCustomer(document, randomUUID(), 'ada@example.test'), true);
  assert.equal(documentReferencesCustomer(document, randomUUID(), 'grace@example.test'), false);
});
