import assert from 'node:assert/strict';
import test from 'node:test';
import { collectPiiValues, erasedEmail, redactJson, redactText, REDACTED } from '../packages/privacy/src/redact.js';

test('redaction removes emails and names from nested payment snapshots', () => {
  const pii = collectPiiValues(['ada.lovelace@example.test', 'Ada Lovelace', '+1-415-555-0101']);
  const redacted = redactJson({
    paymentId: 'pay_1',
    amount: 2500,
    customerEmail: 'ada.lovelace@example.test',
    customer: { email: 'ada.lovelace@example.test', name: 'Ada Lovelace', phone: '+1-415-555-0101' },
    description: 'Order for Ada Lovelace',
  }, pii) as Record<string, unknown>;
  assert.equal(redacted.amount, 2500);
  assert.equal(redacted.paymentId, 'pay_1');
  assert.equal(redacted.customerEmail, REDACTED);
  assert.equal((redacted.customer as Record<string, unknown>).email, REDACTED);
  assert.equal((redacted.customer as Record<string, unknown>).name, REDACTED);
  assert.equal((redacted.customer as Record<string, unknown>).phone, null);
  assert.equal(redacted.description, `Order for ${REDACTED}`);
});

test('erased replacement identities stay deterministic and non-identifying', () => {
  const customerId = '147790aa-64d8-4f18-a650-1b3b006ed06e';
  assert.equal(erasedEmail(customerId), 'erased-147790aa-64d8-4f18-a650-1b3b006ed06e@erased.invalid');
  assert.equal(redactText('Please contact me at ada.lovelace@example.test', ['ada.lovelace@example.test']), `Please contact me at ${REDACTED}`);
});
