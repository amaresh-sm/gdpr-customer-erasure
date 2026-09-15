import assert from 'node:assert/strict';
import test from 'node:test';
import { anonymizedCustomerIdentity, anonymizedCustomerSnapshot, stripPii } from '../packages/privacy/src/redact.js';

test('stripPii removes identifying fields while keeping financial facts', () => {
  const cleaned = stripPii({
    paymentId: 'pay_1',
    amount: 2500,
    currency: 'USD',
    customerEmail: 'ada@example.test',
    email: 'ada@example.test',
    name: 'Ada Lovelace',
    customer: { id: 'cust-1', email: 'ada@example.test', name: 'Ada' },
    customerSnapshot: { id: 'cust-1', phone: '+1-555-0101' },
  }) as Record<string, unknown>;

  assert.equal(cleaned.paymentId, 'pay_1');
  assert.equal(cleaned.amount, 2500);
  assert.equal(cleaned.currency, 'USD');
  assert.equal(cleaned.customerEmail, null);
  assert.equal(cleaned.email, null);
  assert.equal(cleaned.name, null);
  assert.deepEqual(cleaned.customer, { id: 'cust-1', erased: true });
  assert.deepEqual(cleaned.customerSnapshot, { id: 'cust-1', erased: true });
});

test('anonymized customer identity is stable and non-identifying', () => {
  const identity = anonymizedCustomerIdentity('147790aa-64d8-4f18-a650-1b3b006ed06e');
  assert.equal(identity.email.endsWith('@erased.invalid'), true);
  assert.equal(identity.name, 'Erased Customer');
  assert.equal(identity.phone, null);
  assert.deepEqual(anonymizedCustomerSnapshot('147790aa-64d8-4f18-a650-1b3b006ed06e'), {
    id: '147790aa-64d8-4f18-a650-1b3b006ed06e',
    erased: true,
  });
});
