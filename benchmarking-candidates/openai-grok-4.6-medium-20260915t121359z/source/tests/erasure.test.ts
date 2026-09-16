import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  anonymizedCustomerRecord,
  anonymizedCustomerSnapshot,
  erasedEmail,
  erasureErrorCode,
  redactJson,
} from '../packages/privacy/src/redaction.js';
import { customerIdFromEvent } from '../packages/privacy/src/identity.js';
import { toPublicErasureRequest } from '../apps/customer-service/src/erasure-types.js';

test('anonymized customer records keep a stable identifier and drop original PII', () => {
  const customerId = randomUUID();
  const record = anonymizedCustomerRecord(customerId);
  assert.equal(record.email, erasedEmail(customerId));
  assert.equal(record.name, 'ERASED');
  assert.equal(record.phone, null);
  assert.equal(record.status, 'erased');
  assert.doesNotMatch(record.email, /ada|grace|example\.test/i);
});

test('redaction removes nested personal data from retained financial documents', () => {
  const customerId = randomUUID();
  const redacted = redactJson({
    invoiceId: 'inv-1',
    customer: { email: 'ada.lovelace@example.test', name: 'Ada Lovelace', phone: '+1-415-555-0101' },
    customerEmail: 'ada.lovelace@example.test',
    total: 5000,
    currency: 'USD',
  }, customerId) as Record<string, unknown>;
  assert.equal(redacted.total, 5000);
  assert.equal(redacted.currency, 'USD');
  assert.equal(redacted.customerEmail, erasedEmail(customerId));
  const customer = redacted.customer as Record<string, unknown>;
  assert.equal(customer.email, erasedEmail(customerId));
  assert.equal(customer.name, 'ERASED');
  assert.notEqual(customer.phone, '+1-415-555-0101');
});

test('erasure responses expose status without embedding customer personal data', () => {
  const createdAt = new Date('2026-08-20T12:00:00.000Z');
  const body = toPublicErasureRequest({
    id: '0ad18e87-1c3f-4af0-aace-345ab19f7a4a',
    merchant_id: randomUUID(),
    customer_id: '147790aa-64d8-4f18-a650-1b3b006ed06e',
    status: 'failed',
    attempts: 2,
    last_error: 'email_cleanup_failed',
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
  });
  assert.equal(body.status, 'failed');
  assert.equal(body.lastError, 'email_cleanup_failed');
  assert.equal(body.completedAt, null);
  assert.equal(body.createdAt, '2026-08-20T12:00:00.000Z');
  assert.equal(JSON.stringify(body).includes('@'), false);
});

test('event customer identity prefers payload customerId and falls back to customer aggregates', () => {
  const customerId = randomUUID();
  assert.equal(customerIdFromEvent({ customerId }, 'payment_intent', randomUUID()), customerId);
  assert.equal(customerIdFromEvent({}, 'customer', customerId), customerId);
  assert.equal(customerIdFromEvent({}, 'payment_intent', randomUUID()), undefined);
});

test('erasure error codes are stable and never include raw exception text', () => {
  assert.equal(erasureErrorCode(new Error('mailpit_delete_failed:500')), 'email_cleanup_failed');
  assert.equal(erasureErrorCode(new Error('index_not_found_exception')), 'search_cleanup_failed');
  assert.equal(erasureErrorCode(new Error('unexpected')), 'erasure_processing_failed');
  assert.notEqual(erasureErrorCode(new Error('ada.lovelace@example.test')), 'ada.lovelace@example.test');
});

test('anonymized snapshots remain financially attachable by customer id only', () => {
  const customerId = randomUUID();
  const snapshot = anonymizedCustomerSnapshot(customerId);
  assert.equal(snapshot.id, customerId);
  assert.equal(snapshot.status, 'erased');
  assert.equal(snapshot.email, erasedEmail(customerId));
});
