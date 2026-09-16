import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ERASED_CUSTOMER_TOMBSTONE,
  isValidErasureIdempotencyKey,
  PII_PAYLOAD_KEYS,
  scrubPayload,
  serializeErasureRequest,
} from '../packages/privacy/src/redact.js';

test('scrubPayload removes personal-data keys and preserves financial facts', () => {
  const payload = {
    paymentId: randomUUID(),
    customerId: randomUUID(),
    amount: 2500,
    currency: 'USD',
    customerEmail: 'ada.lovelace@example.test',
    email: 'ada.lovelace@example.test',
    name: 'Ada Lovelace',
    phone: '+1-415-555-0101',
    externalReference: 'crm-ada-001',
    billingName: 'Ada Lovelace',
    last4: '4242',
    line1: '100 Market Street',
    subject: 'Question',
    body: 'Please contact me',
    receiptStatus: 'pending',
  };
  const scrubbed = scrubPayload(payload);
  for (const key of PII_PAYLOAD_KEYS) assert.equal(scrubbed[key], undefined, `expected ${key} to be removed`);
  assert.equal(scrubbed.paymentId, payload.paymentId);
  assert.equal(scrubbed.customerId, payload.customerId);
  assert.equal(scrubbed.amount, 2500);
  assert.equal(scrubbed.currency, 'USD');
  assert.equal(scrubbed.receiptStatus, 'pending');
  assert.deepEqual(Object.keys(payload).length, 15, 'scrub must not mutate the original payload');
});

test('scrubPayload tolerates non-object payloads and extra keys', () => {
  assert.deepEqual(scrubPayload(null), {});
  assert.deepEqual(scrubPayload('text'), {});
  assert.deepEqual(scrubPayload([1, 2]), {});
  assert.deepEqual(scrubPayload({ keep: 1, drop: 2 }, ['drop']), { keep: 1 });
});

test('erasure idempotency keys must be 8-200 characters', () => {
  assert.equal(isValidErasureIdempotencyKey('1234567'), false);
  assert.equal(isValidErasureIdempotencyKey('12345678'), true);
  assert.equal(isValidErasureIdempotencyKey('k'.repeat(200)), true);
  assert.equal(isValidErasureIdempotencyKey('k'.repeat(201)), false);
  assert.equal(isValidErasureIdempotencyKey(undefined), false);
  assert.equal(isValidErasureIdempotencyKey(['a', 'b']), false);
  assert.equal(isValidErasureIdempotencyKey(42), false);
});

test('erasure request serialization matches the documented API shape', () => {
  const created = new Date('2026-08-20T12:00:00.000Z');
  const row = {
    id: randomUUID(),
    merchant_id: randomUUID(),
    customer_id: randomUUID(),
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: created,
    updated_at: created,
    completed_at: null,
  };
  const body = serializeErasureRequest(row);
  assert.deepEqual(body, {
    id: row.id,
    customerId: row.customer_id,
    status: 'pending',
    attempts: 0,
    createdAt: created,
    updatedAt: created,
    completedAt: null,
    lastError: null,
  });
  const failure = serializeErasureRequest({ ...row, status: 'failed', last_error: 'erasure_storage_step_failed', attempts: 3 });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.lastError, 'erasure_storage_step_failed');
  assert.equal(failure.attempts, 3);
});

test('erased customer tombstone carries no personal data', () => {
  assert.deepEqual(ERASED_CUSTOMER_TOMBSTONE, { erased: true });
  assert.equal(JSON.stringify(ERASED_CUSTOMER_TOMBSTONE).includes('@'), false);
});
