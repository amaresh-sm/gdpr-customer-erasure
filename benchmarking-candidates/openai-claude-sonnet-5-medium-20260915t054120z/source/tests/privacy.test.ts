import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  anonymizeCustomerSnapshot,
  anonymizeStoredDocument,
  redactedEmail,
  redactedExternalReference,
  REDACTED_NAME,
} from '../packages/privacy/src/anonymize.js';
import { ErasureStepError, toErasureErrorCode } from '../packages/privacy/src/errors.js';

test('anonymizing a customer snapshot removes PII but keeps non-personal fields', () => {
  const customerId = randomUUID();
  const snapshot = {
    id: customerId, email: 'ada@example.test', name: 'Ada Lovelace', phone: '+1-415-555-0101',
    external_reference: 'crm-ada-001', status: 'active',
  };
  const redacted = anonymizeCustomerSnapshot(snapshot, customerId);
  assert.equal(redacted.email, redactedEmail(customerId));
  assert.equal(redacted.name, REDACTED_NAME);
  assert.equal(redacted.phone, null);
  assert.equal(redacted.external_reference, redactedExternalReference(customerId));
  assert.equal(redacted.id, customerId);
  assert.equal(redacted.status, 'active');
});

test('anonymizing a snapshot is deterministic across repeated runs', () => {
  const customerId = randomUUID();
  const snapshot = { id: customerId, email: 'grace@example.test', name: 'Grace Hopper' };
  const first = anonymizeCustomerSnapshot(snapshot, customerId);
  const second = anonymizeCustomerSnapshot(first, customerId);
  assert.deepEqual(first, second);
});

test('anonymizing a stored document only touches the embedded customer profile', () => {
  const customerId = randomUUID();
  const document = {
    receiptNumber: 'pay_123', amount: 2500, currency: 'USD',
    customer: { id: customerId, email: 'katherine@example.test', name: 'Katherine Johnson' },
  };
  const redacted = anonymizeStoredDocument(document, customerId);
  assert.equal(redacted.amount, 2500);
  assert.equal(redacted.currency, 'USD');
  assert.equal((redacted.customer as { email: string }).email, redactedEmail(customerId));
});

test('a stored document without a customer profile is returned unchanged', () => {
  const document = { total: 100 };
  assert.deepEqual(anonymizeStoredDocument(document, randomUUID()), document);
});

test('erasure step failures always carry a stable, PII-free error code', () => {
  const error = new ErasureStepError('storage_unavailable', new Error('object store is down for tenant 1234'));
  assert.equal(toErasureErrorCode(error), 'storage_unavailable');
  assert.equal(toErasureErrorCode(new Error('customer email leaked in a message')), 'erasure_failed');
});
