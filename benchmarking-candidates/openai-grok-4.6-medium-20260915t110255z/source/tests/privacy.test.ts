import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  mapErasureError,
  redactPii,
  toPublicErasureRequest,
} from '../packages/privacy/src/redaction.js';

test('redactPii removes identifying fields while keeping financial facts', () => {
  const customerId = randomUUID();
  const redacted = redactPii({
    paymentId: 'pay_1',
    customerId,
    amount: 2500,
    currency: 'USD',
    customerEmail: 'ada@example.test',
    customerSnapshot: { id: customerId, email: 'ada@example.test', name: 'Ada Lovelace' },
    description: 'Order for Ada',
  }) as Record<string, unknown>;

  assert.equal(redacted.paymentId, 'pay_1');
  assert.equal(redacted.customerId, customerId);
  assert.equal(redacted.amount, 2500);
  assert.equal(redacted.currency, 'USD');
  assert.equal(redacted.customerEmail, null);
  assert.deepEqual(redacted.customerSnapshot, { id: customerId, status: 'erased' });
});

test('erasure errors stay stable and never include customer data', () => {
  assert.equal(mapErasureError(new Error('mailpit_delete_failed:500')), 'mail_provider_unavailable');
  assert.equal(mapErasureError(new Error('search_index_unavailable')), 'search_index_unavailable');
  assert.equal(mapErasureError(new Error('connect ECONNREFUSED 127.0.0.1:6379')), 'cache_unavailable');
  assert.equal(mapErasureError(new Error('ada.lovelace@example.test vanished')), 'erasure_failed');
});

test('public erasure request shape matches the documented contract', () => {
  const id = randomUUID();
  const customerId = randomUUID();
  const createdAt = new Date('2026-08-20T12:00:00.000Z');
  const body = toPublicErasureRequest({
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
  assert.deepEqual(body, {
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
