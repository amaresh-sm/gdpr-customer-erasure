import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { EVENT_TYPES } from '../packages/contracts/src/events.js';
import { toErasureResponse, type ErasureRequestRow } from '../packages/privacy/src/erasure-contract.js';
import {
  anonymizedCustomerFields,
  anonymizedProjection,
  REDACTED,
  redactJson,
} from '../packages/privacy/src/redact.js';

test('erasure responses expose camelCase fields and ISO timestamps', () => {
  const createdAt = new Date('2026-08-20T12:00:00.000Z');
  const row: ErasureRequestRow = {
    id: randomUUID(),
    merchant_id: randomUUID(),
    customer_id: randomUUID(),
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
  };
  assert.deepEqual(toErasureResponse(row), {
    id: row.id,
    customerId: row.customer_id,
    status: 'pending',
    attempts: 0,
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    completedAt: null,
    lastError: null,
  });
});

test('json redaction removes nested personal data while keeping financial identifiers', () => {
  const customerId = randomUUID();
  const redacted = redactJson({
    paymentId: 'pay_1',
    customerId,
    amount: 2500,
    currency: 'USD',
    customerEmail: 'ada@example.test',
    customer: {
      email: 'ada@example.test',
      name: 'Ada Lovelace',
      phone: '+1-415-555-0101',
      external_reference: 'crm-ada-001',
    },
    billingAddress: { line1: '100 Market Street', city: 'San Francisco' },
  });
  assert.equal(redacted.paymentId, 'pay_1');
  assert.equal(redacted.customerId, customerId);
  assert.equal(redacted.amount, 2500);
  assert.equal(redacted.customerEmail, REDACTED);
  assert.equal(redacted.customer.email, REDACTED);
  assert.equal(redacted.customer.name, REDACTED);
  assert.equal(redacted.customer.phone, REDACTED);
  assert.equal(redacted.billingAddress.line1, REDACTED);
});

test('anonymized customer records keep a unique non-identifying placeholder', () => {
  const customerId = randomUUID();
  const fields = anonymizedCustomerFields(customerId);
  assert.equal(fields.email, `erased+${customerId}@invalid.example`);
  assert.equal(fields.external_reference, `erased-${customerId}`);
  assert.equal(fields.name, REDACTED);
  assert.equal(fields.phone, null);
  const projection = anonymizedProjection(randomUUID(), customerId);
  assert.equal(projection.email, fields.email);
  assert.equal(projection.name, REDACTED);
});

test('customer erasure is a versioned domain event', () => {
  assert.equal(EVENT_TYPES.CUSTOMER_ERASED, 'customer.erased.v1');
});
