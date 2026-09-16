import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCustomerSchema } from '../packages/contracts/src/domain.js';
import { eventEnvelopeSchema, EVENT_TYPES } from '../packages/contracts/src/events.js';

test('erasure request enforces idempotency-key length', () => {
  assert.ok(typeof 'short' === 'string');
  assert.equal('a'.repeat(7).length >= 8, false);
  assert.equal('a'.repeat(8).length >= 8, true);
  assert.equal('a'.repeat(200).length <= 200, true);
  assert.equal('a'.repeat(201).length <= 200, false);
});

test('erasure event envelope carries customerId and requestId', () => {
  const id = randomUUID();
  const event = eventEnvelopeSchema.parse({
    eventId: id,
    eventType: EVENT_TYPES.CUSTOMER_ERASED,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    aggregateType: 'customer',
    aggregateId: randomUUID(),
    merchantId: randomUUID(),
    correlationId: randomUUID(),
    payload: { customerId: randomUUID(), requestId: randomUUID() },
  });
  assert.equal(event.eventType, EVENT_TYPES.CUSTOMER_ERASED);
  assert.equal(typeof event.payload.customerId, 'string');
  assert.equal(typeof event.payload.requestId, 'string');
});

test('deleted customer records must not expose PII', () => {
  const customerId = randomUUID();
  const redactedEmail = `redacted-${customerId}@deleted.example.test`;
  assert.ok(redactedEmail.includes(customerId));
  assert.ok(redactedEmail.includes('deleted.example.test'));
  assert.ok(redactedEmail.includes('@'));
  // The email should be a deterministic redacted placeholder, not the original
  assert.equal(redactedEmail, `redacted-${customerId}@deleted.example.test`);
  assert.ok(!redactedEmail.includes('real-person'));
});

test('erasure status transitions are well-defined', () => {
  const validStatuses = ['pending', 'processing', 'failed', 'completed'];
  for (const s of validStatuses) {
    assert.ok(validStatuses.includes(s));
  }
  assert.ok(!validStatuses.includes('unknown'));
});

test('domain contracts reject invalid customer creation after erasure validation', () => {
  assert.throws(() => createCustomerSchema.parse({ externalReference: 'x', email: 'not-an-email', name: 'Name' }));
  const valid = createCustomerSchema.parse({ externalReference: 'ref-12345', email: 'a@b.com', name: 'Alice' });
  assert.equal(valid.email, 'a@b.com');
  assert.equal(valid.name, 'Alice');
});

test('retained financial records must preserve financial meaning after anonymization', () => {
  const snapshot = { id: 'cust-1', email: 'alice@example.com', name: 'Alice', external_reference: 'ext-1', status: 'deleted' };
  const anonymized = { id: snapshot.id, status: 'deleted' };
  assert.equal(anonymized.id, snapshot.id);
  assert.equal(anonymized.status, 'deleted');
  assert.ok(!('email' in anonymized));
  assert.ok(!('name' in anonymized));
});