import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  erasedCustomerProjection,
  erasureLockKey,
  ERASURE_ERROR_CODES,
  ErasureStepError,
  importReferencesCustomer,
  scrubStoredDocument,
} from '../packages/privacy/src/erasure.js';
import {
  isValidErasureIdempotencyKey,
  serializeErasureRequest,
  type ErasureRequestSnapshot,
} from '../packages/contracts/src/erasure.js';

test('stored documents keep financial meaning while the customer block is tombstoned', () => {
  const receipt = JSON.stringify({
    receiptNumber: 'pay-1', issuedAt: '2026-08-20T12:00:00.000Z',
    customer: { id: 'cust-1', email: 'ada@example.test', name: 'Ada Lovelace' },
    amount: 2500, currency: 'USD',
  });
  const scrubbed = scrubStoredDocument(receipt);
  assert.ok(scrubbed);
  const parsed = JSON.parse(scrubbed) as Record<string, unknown>;
  assert.deepEqual(parsed.customer, { erased: true });
  assert.equal(parsed.amount, 2500);
  assert.equal(parsed.currency, 'USD');
  assert.equal(parsed.receiptNumber, 'pay-1');
  assert.ok(!scrubbed.includes('ada@example.test'));
  assert.ok(!scrubbed.includes('Ada Lovelace'));
});

test('document scrubbing is idempotent and ignores documents without customer data', () => {
  assert.equal(scrubStoredDocument(JSON.stringify({ customer: { erased: true }, amount: 10 })), null);
  assert.equal(scrubStoredDocument(JSON.stringify({ amount: 10 })), null);
  assert.equal(scrubStoredDocument('not json'), null);
  assert.equal(scrubStoredDocument(JSON.stringify([1, 2, 3])), null);
});

test('import artifacts match the erased customer by id, email, or external reference', () => {
  const identifiers = { customerId: 'cust-1', email: 'ada@example.test', externalReference: 'crm-ada-001' };
  assert.equal(importReferencesCustomer(JSON.stringify({ customerId: 'cust-1', notes: 'x' }), identifiers), true);
  assert.equal(importReferencesCustomer(JSON.stringify({ contact: { emails: ['ada@example.test'] } }), identifiers), true);
  assert.equal(importReferencesCustomer(JSON.stringify(['crm-ada-001']), identifiers), true);
  assert.equal(importReferencesCustomer(JSON.stringify({ customerId: 'cust-2', email: 'grace@example.test' }), identifiers), false);
  assert.equal(importReferencesCustomer('not json', identifiers), false);
  assert.equal(importReferencesCustomer(JSON.stringify({ customerId: 'cust-1' }), { customerId: 'cust-1', email: null, externalReference: null }), true);
});

test('erasure idempotency keys must be 8 to 200 characters', () => {
  assert.equal(isValidErasureIdempotencyKey('12345678'), true);
  assert.equal(isValidErasureIdempotencyKey('x'.repeat(200)), true);
  assert.equal(isValidErasureIdempotencyKey('short'), false);
  assert.equal(isValidErasureIdempotencyKey('x'.repeat(201)), false);
  assert.equal(isValidErasureIdempotencyKey(undefined), false);
  assert.equal(isValidErasureIdempotencyKey(['key']), false);
});

test('erasure request serialization matches the public API contract', () => {
  const row: ErasureRequestSnapshot = {
    id: randomUUID(),
    customer_id: randomUUID(),
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: new Date('2026-08-20T12:00:00.000Z'),
    updated_at: new Date('2026-08-20T12:00:00.000Z'),
    completed_at: null,
  };
  const body = serializeErasureRequest(row);
  assert.deepEqual(Object.keys(body).sort(), ['attempts', 'completedAt', 'createdAt', 'customerId', 'id', 'lastError', 'status', 'updatedAt'].sort());
  assert.equal(body.id, row.id);
  assert.equal(body.customerId, row.customer_id);
  assert.equal(body.status, 'pending');
  assert.equal(body.attempts, 0);
  assert.equal(body.createdAt, '2026-08-20T12:00:00.000Z');
  assert.equal(body.completedAt, null);
  assert.equal(body.lastError, null);
  assert.ok(!('merchant_id' in body) && !('idempotency_key' in body));
});

test('erasure failure codes are stable and carry no customer data', () => {
  assert.deepEqual(ERASURE_ERROR_CODES, [
    'database_cleanup_failed',
    'object_store_cleanup_failed',
    'cache_cleanup_failed',
    'search_cleanup_failed',
  ]);
  const error = new ErasureStepError('cache_cleanup_failed', new Error('boom'));
  assert.equal(error.code, 'cache_cleanup_failed');
  assert.equal(error.message, 'cache_cleanup_failed');
});

test('erasure projections and lock keys contain no personal data', () => {
  const merchantId = randomUUID();
  const customerId = randomUUID();
  const projection = erasedCustomerProjection(merchantId, customerId);
  assert.equal(projection.erased, true);
  assert.equal(projection.merchantId, merchantId);
  assert.equal(projection.customerId, customerId);
  assert.ok(!('email' in projection) && !('name' in projection) && !('phone' in projection));
  assert.equal(erasureLockKey(merchantId, customerId), `customer-erasure:${merchantId}:${customerId}`);
});
