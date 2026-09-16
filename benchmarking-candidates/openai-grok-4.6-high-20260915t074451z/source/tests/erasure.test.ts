import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyErasureError, erasedCustomerRecord, redactPii } from '../packages/privacy/src/redact.js';

test('erased customer records keep only the identifier and status', () => {
  assert.deepEqual(erasedCustomerRecord('11111111-1111-4111-8111-111111111111'), {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'erased',
  });
});

test('payload redaction removes personal data without dropping financial facts', () => {
  const redacted = redactPii({
    paymentId: 'pay_1',
    amount: 2500,
    currency: 'USD',
    email: 'ada@example.test',
    customerEmail: 'ada@example.test',
    name: 'Ada Lovelace',
    customer: { id: 'cust_1', email: 'ada@example.test', name: 'Ada Lovelace' },
    customerSnapshot: { id: 'cust_1', email: 'ada@example.test', phone: '+1-415-555-0101' },
  }) as Record<string, unknown>;

  assert.equal(redacted.paymentId, 'pay_1');
  assert.equal(redacted.amount, 2500);
  assert.equal(redacted.currency, 'USD');
  assert.equal(redacted.erased, true);
  assert.equal('email' in redacted, false);
  assert.equal('customerEmail' in redacted, false);
  assert.equal('name' in redacted, false);
  assert.deepEqual(redacted.customer, { id: 'cust_1', status: 'erased' });
  assert.deepEqual(redacted.customerSnapshot, { id: 'cust_1', status: 'erased' });
});

test('erasure errors map to stable codes without embedding customer data', () => {
  assert.equal(classifyErasureError(new Error('mailpit_delete_failed:500')), 'notification_store_unavailable');
  assert.equal(classifyErasureError(new Error('index_not_found_exception')), 'search_index_unavailable');
  assert.equal(classifyErasureError(new Error('ECONNREFUSED 127.0.0.1:6379')), 'cache_unavailable');
  assert.equal(classifyErasureError(new Error('unexpected')), 'cleanup_failed');
});
