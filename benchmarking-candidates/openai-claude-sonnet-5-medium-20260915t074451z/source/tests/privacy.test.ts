import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { erasedEmailFor, isValidIdempotencyKey, redactSnapshot } from '../apps/customer-service/src/erasure-redaction.js';

test('erased email placeholders are deterministic and stay unique per customer', () => {
  const customerId = randomUUID();
  assert.equal(erasedEmailFor(customerId), erasedEmailFor(customerId));
  assert.notEqual(erasedEmailFor(customerId), erasedEmailFor(randomUUID()));
  assert.match(erasedEmailFor(customerId), /^erased-.+@deleted\.payflow\.invalid$/);
});

test('idempotency keys must be within the documented 8-200 character range', () => {
  assert.equal(isValidIdempotencyKey('short'), false);
  assert.equal(isValidIdempotencyKey('a'.repeat(8)), true);
  assert.equal(isValidIdempotencyKey('a'.repeat(200)), true);
  assert.equal(isValidIdempotencyKey('a'.repeat(201)), false);
});

test('redacting a financial snapshot removes personal fields but preserves financial meaning', () => {
  const customerId = randomUUID();
  const snapshot = {
    id: customerId, email: 'ada@example.test', name: 'Ada Lovelace', phone: '+1-555-0100',
    external_reference: 'crm-001', status: 'active',
  };
  const redacted = redactSnapshot(snapshot, customerId);
  assert.equal(redacted.id, customerId);
  assert.equal(redacted.status, 'active');
  assert.equal(redacted.email, erasedEmailFor(customerId));
  assert.equal(redacted.name, 'Erased Customer');
  assert.equal(redacted.phone, null);
  assert.equal(redacted.external_reference, null);
});

test('redacting a snapshot is idempotent', () => {
  const customerId = randomUUID();
  const snapshot = { id: customerId, email: 'ada@example.test', name: 'Ada Lovelace' };
  const once = redactSnapshot(snapshot, customerId);
  const twice = redactSnapshot(once, customerId);
  assert.deepEqual(once, twice);
});
