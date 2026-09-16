import assert from 'node:assert/strict';
import test from 'node:test';
import { redactCustomerPayload } from '../packages/operations/src/pii-redaction.js';

test('redacting a customer payload replaces identifying fields but preserves financial fields', () => {
  const original = {
    id: 'cus_1', email: 'ada@example.test', name: 'Ada Lovelace', phone: '+1-555-0100',
    externalReference: 'crm-1', amount: 1200, currency: 'USD', status: 'active',
  };
  const redacted = redactCustomerPayload(original);
  assert.equal(redacted.id, 'cus_1');
  assert.equal(redacted.amount, 1200);
  assert.equal(redacted.currency, 'USD');
  assert.notEqual(redacted.email, original.email);
  assert.notEqual(redacted.name, original.name);
  assert.equal(redacted.phone, null);
  assert.notEqual(redacted.externalReference, original.externalReference);
});

test('redacting nested structures preserves shape and array length', () => {
  const original = {
    lines: [{ description: 'Subscription', quantity: 1, unitAmount: 500 }],
    customer: { email: 'grace@example.test', name: 'Grace Hopper' },
  };
  const redacted = redactCustomerPayload(original);
  assert.equal(redacted.lines.length, 1);
  assert.equal(redacted.lines[0]!.unitAmount, 500);
  assert.notEqual(redacted.customer.email, original.customer.email);
});

test('redacting is deterministic and idempotent', () => {
  const original = { email: 'katherine@example.test', amount: 100 };
  const once = redactCustomerPayload(original);
  const twice = redactCustomerPayload(once);
  assert.deepEqual(once, twice);
});
