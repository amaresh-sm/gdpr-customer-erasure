import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCustomerSchema, createPaymentSchema, createRefundSchema } from '../packages/contracts/src/domain.js';
import { eventEnvelopeSchema } from '../packages/contracts/src/events.js';
import { requestHash } from '../apps/payment-service/src/idempotency.js';

test('domain contracts normalize currency and reject invalid monetary values', () => {
  assert.equal(createPaymentSchema.parse({ customerId: randomUUID(), paymentMethodId: randomUUID(), amount: 100, currency: 'usd' }).currency, 'USD');
  assert.throws(() => createPaymentSchema.parse({ customerId: randomUUID(), paymentMethodId: randomUUID(), amount: 0, currency: 'USD' }));
  assert.throws(() => createRefundSchema.parse({ amount: -1, reason: 'bad' }));
  assert.throws(() => createCustomerSchema.parse({ externalReference: 'x', email: 'not-an-email', name: 'Name' }));
});

test('event envelopes require tenant, aggregate, and correlation identities', () => {
  const id = randomUUID();
  const event = eventEnvelopeSchema.parse({ eventId: id, eventType: 'customer.created.v1', eventVersion: 1,
    occurredAt: new Date().toISOString(), aggregateType: 'customer', aggregateId: randomUUID(), merchantId: randomUUID(),
    correlationId: randomUUID(), payload: { email: 'person@example.test' } });
  assert.equal(event.eventId, id);
  assert.throws(() => eventEnvelopeSchema.parse({ ...event, merchantId: 'missing' }));
});

test('idempotency hashes are deterministic and payload-sensitive', () => {
  assert.equal(requestHash({ amount: 100 }), requestHash({ amount: 100 }));
  assert.notEqual(requestHash({ amount: 100 }), requestHash({ amount: 101 }));
});
