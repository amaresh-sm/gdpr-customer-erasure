import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  erasedEmail,
  erasedExternalReference,
  erasureErrorCode,
  importContainsCustomer,
  redactDocumentCustomer,
  toErasureResponse,
} from '../apps/customer-service/src/erasure-policy.js';

test('erasure responses expose public fields without leaking storage names', () => {
  const id = randomUUID();
  const customerId = randomUUID();
  const createdAt = new Date('2026-08-20T12:00:00.000Z');
  const response = toErasureResponse({
    id,
    merchant_id: randomUUID(),
    customer_id: customerId,
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
  });
  assert.deepEqual(response, {
    id,
    customerId,
    status: 'pending',
    attempts: 0,
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    completedAt: null,
    lastError: null,
  });
});

test('import matching finds a customer by id or email without matching other records', () => {
  const customerId = randomUUID();
  const content = JSON.stringify({ customerId, email: 'ada@example.test', notes: 'priority' });
  assert.equal(importContainsCustomer(content, customerId, ['ada@example.test']), true);
  assert.equal(importContainsCustomer(content, randomUUID(), ['ada@example.test']), true);
  assert.equal(importContainsCustomer(content, randomUUID(), ['grace@example.test']), false);
});

test('retained documents keep financial meaning after customer fields are removed', () => {
  const customerId = randomUUID();
  const redacted = redactDocumentCustomer({
    invoiceId: 'inv_1',
    total: 5000,
    currency: 'USD',
    customer: { id: customerId, email: 'ada@example.test', name: 'Ada Lovelace' },
    customerEmail: 'ada@example.test',
    email: 'ada@example.test',
  }, customerId);
  assert.deepEqual(redacted.customer, { id: customerId, status: 'erased' });
  assert.equal(redacted.total, 5000);
  assert.equal(redacted.currency, 'USD');
  assert.equal('email' in redacted, false);
  assert.equal('customerEmail' in redacted, false);
});

test('erasure helpers keep only non-identifying placeholders and stable error codes', () => {
  const customerId = randomUUID();
  assert.equal(erasedEmail(customerId), `erased-${customerId}@erased.invalid`);
  assert.equal(erasedExternalReference(customerId), `erased-${customerId}`);
  assert.equal(erasureErrorCode(new Error('OpenSearch cluster is down')), 'search_unavailable');
  assert.equal(erasureErrorCode(new Error('redis connection refused')), 'cache_unavailable');
  assert.equal(erasureErrorCode(new Error('minio timeout')), 'document_store_unavailable');
  assert.equal(erasureErrorCode(new Error('mailpit_delete_failed:500')), 'notification_store_unavailable');
  assert.equal(erasureErrorCode(new Error('unexpected')), 'cleanup_failed');
});
