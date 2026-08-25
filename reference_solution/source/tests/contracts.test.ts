import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCustomerSchema, createPaymentSchema, createRefundSchema } from '../packages/contracts/src/domain.js';
import { eventEnvelopeSchema } from '../packages/contracts/src/events.js';
import { requestHash } from '../apps/payment-service/src/idempotency.js';
import { containsSubjectValue, redactSubjectValue } from '../packages/privacy/src/redact.js';

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

test('privacy redaction replaces only the selected subject and preserves financial values', () => {
  const context = { merchantId: randomUUID(), customerId: randomUUID(), surrogateId: randomUUID(),
    sensitiveValues: ['erase-me@example.test', 'Erase Me', 'pcus_erase_me'] };
  const input = { customerId: context.customerId, email: 'erase-me@example.test', amount: 4200,
    providerCustomerId: 'pcus_erase_me', survivor: 'survivor@example.test', nested: { description: 'Invoice for Erase Me' } };
  const output = redactSubjectValue(input, context);
  assert.equal(output.customerId, context.surrogateId);
  assert.equal(output.email, '[redacted]');
  assert.equal(output.providerCustomerId, '[redacted]');
  assert.equal(output.amount, 4200);
  assert.equal(output.survivor, 'survivor@example.test');
  assert.equal(output.nested.description, 'Invoice for [redacted]');
  assert.equal(containsSubjectValue(output, context), false);
});
