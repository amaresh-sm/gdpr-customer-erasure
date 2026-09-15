import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ERASURE_ERROR_CODES,
  ERASURE_STEPS,
  ErasureStepError,
  erasureErrorCode,
  redactDocument,
  redactedCustomerSnapshot,
  REDACTED_TEXT,
  UNKNOWN_ERASURE_ERROR_CODE,
} from '../packages/privacy/src/redaction.js';
import { isValidIdempotencyKey } from '../packages/privacy/src/idempotency.js';

test('a redacted snapshot keeps the pseudonymous reference and drops every identifying attribute', () => {
  const customerId = randomUUID();
  const snapshot = redactedCustomerSnapshot(customerId);
  assert.equal(snapshot.id, customerId);
  assert.equal(snapshot.status, 'erased');
  assert.deepEqual(
    Object.entries(snapshot).filter(([, value]) => typeof value === 'string' && value.includes('@')),
    [],
  );
  for (const attribute of ['email', 'name', 'phone', 'external_reference'] as const) {
    assert.equal(snapshot[attribute], null, `${attribute} was retained`);
  }
});

test('retained documents keep their financial meaning and stop identifying the customer', () => {
  const customerId = randomUUID();
  const invoice = {
    invoiceId: randomUUID(),
    number: 'INV-2026-ABCD1234',
    currency: 'USD',
    subtotal: 5_000,
    tax: 175,
    total: 5_175,
    issuedAt: '2026-08-20T12:00:00.000Z',
    customer: { id: customerId, email: 'ada@example.test', name: 'Ada Lovelace', phone: '+1-415-555-0101' },
    lines: [{ description: 'Annual subscription for Ada Lovelace', quantity: 2, unitAmount: 2_500, total: 5_000 }],
  };

  const redacted = redactDocument(invoice, customerId) as typeof invoice;

  assert.equal(redacted.number, invoice.number);
  assert.equal(redacted.currency, 'USD');
  assert.equal(redacted.subtotal, 5_000);
  assert.equal(redacted.tax, 175);
  assert.equal(redacted.total, 5_175);
  assert.equal(redacted.issuedAt, invoice.issuedAt);
  assert.equal(redacted.lines[0]!.quantity, 2);
  assert.equal(redacted.lines[0]!.unitAmount, 2_500);
  assert.equal(redacted.lines[0]!.total, 5_000);
  assert.equal(redacted.lines[0]!.description, REDACTED_TEXT);
  assert.equal(redacted.customer.email, null);
  assert.equal(redacted.customer.name, null);
  assert.equal(redacted.customer.id, customerId);
  assert.equal(JSON.stringify(redacted).includes('Ada Lovelace'), false);
  assert.equal(JSON.stringify(redacted).includes('ada@example.test'), false);
});

test('redaction reaches personal data nested at any depth', () => {
  const customerId = randomUUID();
  const nested = redactDocument({
    receiptNumber: 'r-1',
    amount: 2_500,
    audit: [{ actor: { email: 'support@example.test' }, entries: [{ body: 'called Ada on +1-415-555-0101' }] }],
  }, customerId);
  assert.equal(JSON.stringify(nested).includes('support@example.test'), false);
  assert.equal(JSON.stringify(nested).includes('+1-415-555-0101'), false);
  assert.equal(JSON.stringify(nested).includes('2500'), true);
});

test('every erasure step reports a stable failure code that carries no customer data', () => {
  const customerId = randomUUID();
  for (const step of ERASURE_STEPS) {
    const code = erasureErrorCode(new ErasureStepError(step, new Error(`failed for ada+${customerId}@example.test`)));
    assert.equal(code, ERASURE_ERROR_CODES[step]);
    assert.equal(code.includes(customerId), false);
    assert.equal(code.includes('@'), false);
    assert.match(code, /^[a-z_]+$/);
  }
  assert.equal(erasureErrorCode(new Error('connection to 10.0.0.1 for ada@example.test failed')), UNKNOWN_ERASURE_ERROR_CODE);
});

test('the erasure order removes the customer record only after the steps that need it', () => {
  const order = [...ERASURE_STEPS];
  assert.equal(order[0], 'block_new_processing', 'new processing must be blocked first');
  assert.equal(order.at(-1), 'delete_customer_record', 'the customer record must be deleted last');
  for (const step of ['purge_captured_mail', 'redact_stored_documents', 'purge_projections'] as const) {
    assert.ok(order.indexOf(step) < order.indexOf('delete_customer_record'), `${step} runs too late`);
  }
  assert.equal(new Set(order).size, order.length, 'steps must be unique');
});

test('erasure idempotency keys accept the documented length range', () => {
  assert.equal(isValidIdempotencyKey('a'.repeat(8)), true);
  assert.equal(isValidIdempotencyKey('a'.repeat(200)), true);
  assert.equal(isValidIdempotencyKey('a'.repeat(7)), false);
  assert.equal(isValidIdempotencyKey('a'.repeat(201)), false);
  assert.equal(isValidIdempotencyKey(undefined), false);
  assert.equal(isValidIdempotencyKey(12_345_678), false);
});
