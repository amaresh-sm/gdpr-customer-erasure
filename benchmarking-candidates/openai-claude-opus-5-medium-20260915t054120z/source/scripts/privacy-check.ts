import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../packages/config/src/index.js';
import { pool } from '../packages/database/src/pool.js';
import { CUSTOMER_INDEX, searchClient } from '../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../packages/storage/src/minio.js';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const apiKey = process.env.PAYFLOW_API_KEY ?? 'pf_local_dev_northstar_4ad1539de977';
const otherApiKey = process.env.PAYFLOW_OTHER_API_KEY ?? 'pf_local_dev_bluebird_924bd90d2201';
const runId = randomUUID().slice(0, 8);

interface ApiResult<T> { status: number; body: T }

async function call<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
  key = apiKey,
): Promise<ApiResult<T>> {
  const requestHeaders: Record<string, string> = { authorization: `Bearer ${key}`, ...headers };
  const init: RequestInit = { method, headers: requestHeaders };
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${gateway}${path}`, init);
  return { status: response.status, body: await response.json() as T };
}

async function api<T>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const result = await call<T>(path, method, body, headers);
  if (result.status >= 400) throw new Error(`${method} ${path} failed (${result.status}): ${JSON.stringify(result.body)}`);
  return result.body;
}

interface Subject {
  customerId: string;
  paymentId: string;
  invoiceId: string;
  email: string;
  name: string;
  phone: string;
  externalReference: string;
}

async function createSubject(label: string, phone: string): Promise<Subject> {
  const email = `privacy.${label}.${runId}@example.test`;
  const name = `Privacy Subject ${label} ${runId}`;
  const externalReference = `crm-privacy-${label}-${runId}`;
  const customer = await api<{ id: string }>('/v1/customers', 'POST', {
    externalReference, email, name, phone, metadata: { segment: 'privacy', note: name },
  });
  await api(`/v1/customers/${customer.id}/addresses`, 'POST', {
    kind: 'billing', line1: '9 Erasure Way', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US',
  });
  await api(`/v1/customers/${customer.id}/contacts`, 'POST', { kind: 'email', value: email, isPrimary: true });
  const method = await api<{ id: string }>(`/v1/customers/${customer.id}/payment-methods`, 'POST', {
    providerToken: `tok_privacy_${randomUUID()}`, type: 'card', brand: 'visa', last4: '4242', billingName: name,
    billingAddress: { line1: '9 Erasure Way', city: 'San Francisco', postalCode: '94105', country: 'US' },
  });
  await api(`/v1/customers/${customer.id}/support-tickets`, 'POST', {
    subject: 'Erasure question', body: `Reach me at ${email} or ${phone}.`,
  });
  await api('/v1/customer-imports', 'POST', {
    source: 'legacy-crm', record: { customerId: customer.id, email, name, phone, externalReference },
  });
  const invoice = await api<{ id: string }>('/v1/invoices', 'POST', {
    customerId: customer.id, currency: 'USD', tax: 100,
    lines: [{ description: `Subscription for ${name}`, quantity: 1, unitAmount: 4_000 }],
  });
  const payment = await api<{ id: string }>('/v1/payments', 'POST', {
    customerId: customer.id, paymentMethodId: method.id, amount: 3_300, currency: 'USD',
    description: `Order for ${name}`,
  }, { 'idempotency-key': `privacy-${label}-${runId}-${randomUUID()}` });
  return { customerId: customer.id, paymentId: payment.id, invoiceId: invoice.id, email, name, phone, externalReference };
}

async function waitForPayment(paymentId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const payment = await api<{ status: string }>(`/v1/payments/${paymentId}`);
    if (payment.status === 'succeeded') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('payment did not reach a terminal state');
}

async function waitForConverged(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await pool.query<{ pending: string }>(`
      SELECT ((SELECT count(*) FROM operations.outbox_events WHERE status<>'published')
            + (SELECT count(*) FROM operations.jobs WHERE status NOT IN ('completed','dead'))
            + (SELECT count(*) FROM operations.email_deliveries WHERE status NOT IN ('delivered','cancelled'))
            + (SELECT count(*) FROM operations.provider_webhooks WHERE status<>'processed'))::text pending`);
    if (Number(result.rows[0]!.pending) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('asynchronous work did not converge');
}

interface ErasureRequest {
  id: string; customerId: string; status: string; attempts: number;
  createdAt: string; updatedAt: string; completedAt: string | null; lastError: string | null;
}

async function waitForCompletion(requestId: string): Promise<ErasureRequest> {
  let last: ErasureRequest | undefined;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    last = await api<ErasureRequest>(`/v1/erasure-requests/${requestId}`);
    if (last.status === 'completed') return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`erasure request did not complete: ${JSON.stringify(last)}`);
}

async function databaseMentions(needles: string[]): Promise<string[]> {
  const columns = await pool.query<{ table_schema: string; table_name: string; column_name: string }>(`
    SELECT c.table_schema,c.table_name,c.column_name
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE t.table_type='BASE TABLE'
      AND c.table_schema IN ('platform','customers','payments','operations','provider_sandbox','privacy')
      AND c.data_type IN ('text','character varying','character','jsonb','json')`);
  const patterns = needles.map((needle) => `%${needle}%`);
  const found: string[] = [];
  for (const column of columns.rows) {
    const table = `"${column.table_schema}"."${column.table_name}"`;
    const result = await pool.query<{ hits: string }>(
      `SELECT count(*)::text hits FROM ${table} WHERE "${column.column_name}"::text ILIKE ANY($1::text[])`,
      [patterns],
    );
    if (Number(result.rows[0]!.hits) > 0) {
      found.push(`${column.table_schema}.${column.table_name}.${column.column_name}`);
    }
  }
  return found;
}

async function storedObjectMentions(needles: string[]): Promise<string[]> {
  const keys: string[] = await new Promise((resolve, reject) => {
    const collected: string[] = [];
    const stream = objectStore.listObjectsV2(DOCUMENT_BUCKET, '', true);
    stream.on('data', (item) => { if (item.name) collected.push(item.name); });
    stream.on('error', reject);
    stream.on('end', () => resolve(collected));
  });
  const found: string[] = [];
  for (const key of keys) {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    const body = Buffer.concat(chunks).toString('utf8');
    if (needles.some((needle) => body.includes(needle))) found.push(key);
  }
  return found;
}

// Identifiers are unique per run so a leak can only be attributed to the erased subject.
const phoneRoot = BigInt(`0x${randomUUID().replaceAll('-', '')}`).toString(10).slice(0, 7);
const subject = await createSubject('erased', `+1-206-${phoneRoot}-0001`);
const bystander = await createSubject('retained', `+1-206-${phoneRoot}-0002`);
await waitForPayment(subject.paymentId);
await waitForPayment(bystander.paymentId);
await api(`/v1/payments/${subject.paymentId}/refunds`, 'POST', { amount: 300, reason: 'privacy check refund' });
await waitForConverged();

const financialBefore = await pool.query<{ payments: string; captures: string; entries: string; invoices: string }>(
  `SELECT (SELECT count(*)::text FROM payments.payment_intents WHERE customer_id=$1) payments,
          (SELECT count(*)::text FROM payments.captures WHERE payment_intent_id=$2) captures,
          (SELECT count(*)::text FROM payments.ledger_entries WHERE reference_id=$2) entries,
          (SELECT count(*)::text FROM payments.invoices WHERE customer_id=$1) invoices`,
  [subject.customerId, subject.paymentId],
);

const idempotencyKey = `privacy-erasure-${runId}`;
const accepted = await call<ErasureRequest>(
  `/v1/customers/${subject.customerId}/erasure-requests`, 'POST', undefined, { 'idempotency-key': idempotencyKey },
);
assert.equal(accepted.status, 202, 'erasure request was not accepted');
assert.equal(accepted.body.customerId, subject.customerId);
assert.equal(accepted.body.status === 'pending' || accepted.body.status === 'processing', true, 'unexpected initial status');
assert.equal(accepted.body.completedAt, null);
assert.equal(accepted.body.lastError, null);

const replay = await call<ErasureRequest>(
  `/v1/customers/${subject.customerId}/erasure-requests`, 'POST', undefined, { 'idempotency-key': idempotencyKey },
);
assert.equal(replay.status, 202);
assert.equal(replay.body.id, accepted.body.id, 'idempotent replay created a different request');

const reusedKey = await call<{ error: string }>(
  `/v1/customers/${bystander.customerId}/erasure-requests`, 'POST', undefined, { 'idempotency-key': idempotencyKey },
);
assert.equal(reusedKey.status, 409, 'reusing a key for another customer was not rejected');

const missingCustomer = await call<{ error: string }>(
  `/v1/customers/${randomUUID()}/erasure-requests`, 'POST', undefined, { 'idempotency-key': `absent-${runId}` },
);
assert.equal(missingCustomer.status, 404, 'unknown customer was not rejected');

const badKey = await call<{ error: string }>(
  `/v1/customers/${subject.customerId}/erasure-requests`, 'POST', undefined, { 'idempotency-key': 'short' },
);
assert.equal(badKey.status, 400, 'a too-short idempotency key was accepted');

const completed = await waitForCompletion(accepted.body.id);
assert.equal(completed.id, accepted.body.id);
assert.ok(completed.completedAt, 'completed request has no completion timestamp');
assert.equal(completed.lastError, null);

const secondRequest = await call<ErasureRequest>(
  `/v1/customers/${subject.customerId}/erasure-requests`, 'POST', undefined, { 'idempotency-key': `second-${runId}` },
);
assert.equal(secondRequest.status, 202, 'a repeat request was not accepted');
assert.equal(secondRequest.body.id, accepted.body.id, 'a repeat request started a second workflow');

const foreignRead = await call<{ error: string }>(
  `/v1/erasure-requests/${accepted.body.id}`, 'GET', undefined, {}, otherApiKey,
);
assert.equal(foreignRead.status, 404, 'another merchant could read the request');
const unknownRead = await call<{ error: string }>(`/v1/erasure-requests/${randomUUID()}`);
assert.equal(unknownRead.status, 404, 'an unknown request id was not rejected');

const customerRead = await call<{ error: string }>(`/v1/customers/${subject.customerId}`);
assert.equal(customerRead.status, 404, 'the erased customer is still readable');
const rejectedPayment = await call<{ error: string }>('/v1/payments', 'POST', {
  customerId: subject.customerId, paymentMethodId: randomUUID(), amount: 100, currency: 'USD',
}, { 'idempotency-key': `after-erasure-${runId}` });
assert.ok(rejectedPayment.status >= 400, 'a payment was accepted for an erased customer');

await waitForConverged();
const needles = [subject.email, subject.name, subject.phone, subject.externalReference];
const leakedColumns = await databaseMentions(needles);
assert.deepEqual(leakedColumns, [], `personal data remains in ${leakedColumns.join(', ')}`);
const leakedObjects = await storedObjectMentions(needles);
assert.deepEqual(leakedObjects, [], `personal data remains in stored objects ${leakedObjects.join(', ')}`);

const redis = new Redis(config().REDIS_URL);
const cachedKeys = await redis.keys(`merchant:*:customer:${subject.customerId}*`);
assert.deepEqual(cachedKeys, [], `cached projections remain: ${cachedKeys.join(', ')}`);
const bystanderCache = await redis.keys(`merchant:*:customer:${bystander.customerId}`);
assert.equal(bystanderCache.length, 1, 'another customer lost cached projections');
await redis.quit();

const searchHits = await searchClient.search({
  index: CUSTOMER_INDEX, body: { query: { term: { customerId: subject.customerId } } },
});
assert.equal(searchHits.body.hits.hits.length, 0, 'the search index still returns the erased customer');
const bystanderHits = await searchClient.search({
  index: CUSTOMER_INDEX, body: { query: { term: { customerId: bystander.customerId } } },
});
assert.equal(bystanderHits.body.hits.hits.length, 1, 'another customer lost its search document');

const mailSearch = await fetch(
  `${config().MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:${subject.email}`)}`,
);
const captured = await mailSearch.json() as { messages?: unknown[] };
assert.equal(captured.messages?.length ?? 0, 0, 'captured mail still addresses the erased customer');

const financialAfter = await pool.query<{
  payments: string; captures: string; entries: string; invoices: string; refunds: string;
  unbalanced: string; snapshot: string; refund_email: string;
}>(
  `SELECT (SELECT count(*)::text FROM payments.payment_intents WHERE customer_id=$1) payments,
          (SELECT count(*)::text FROM payments.captures WHERE payment_intent_id=$2) captures,
          (SELECT count(*)::text FROM payments.ledger_entries WHERE reference_id=$2) entries,
          (SELECT count(*)::text FROM payments.invoices WHERE customer_id=$1) invoices,
          (SELECT count(*)::text FROM payments.refunds WHERE payment_intent_id=$2) refunds,
          (SELECT count(*)::text FROM (
            SELECT e.id FROM payments.ledger_entries e JOIN payments.ledger_postings p ON p.entry_id=e.id
            GROUP BY e.id HAVING sum(CASE WHEN p.direction='debit' THEN p.amount ELSE -p.amount END)<>0
          ) invalid) unbalanced,
          (SELECT customer_snapshot->>'status' FROM payments.payment_intents WHERE id=$2) snapshot,
          (SELECT count(*)::text FROM payments.refunds WHERE payment_intent_id=$2 AND customer_email IS NOT NULL) refund_email`,
  [subject.customerId, subject.paymentId],
);
const retained = financialAfter.rows[0]!;
assert.equal(retained.payments, financialBefore.rows[0]!.payments, 'payment records were destroyed');
assert.equal(retained.captures, financialBefore.rows[0]!.captures, 'captures were destroyed');
assert.equal(retained.entries, financialBefore.rows[0]!.entries, 'ledger entries were destroyed');
assert.equal(retained.invoices, financialBefore.rows[0]!.invoices, 'invoices were destroyed');
assert.ok(Number(retained.refunds) >= 1, 'refunds were destroyed');
assert.equal(retained.unbalanced, '0', 'ledger became unbalanced');
assert.equal(retained.snapshot, 'erased', 'the retained payment snapshot was not redacted');
assert.equal(retained.refund_email, '0', 'a refund still identifies the erased customer');

const amounts = await pool.query<{ amount: string; currency: string; status: string }>(
  `SELECT amount::text,currency,status FROM payments.payment_intents WHERE id=$1`, [subject.paymentId],
);
assert.equal(amounts.rows[0]!.amount, '3300', 'the retained payment amount changed');
assert.equal(amounts.rows[0]!.currency, 'USD', 'the retained payment currency changed');

const bystanderIntact = await pool.query<{ email: string; addresses: string; methods: string }>(
  `SELECT (SELECT email FROM customers.customers WHERE id=$1) email,
          (SELECT count(*)::text FROM customers.addresses WHERE customer_id=$1) addresses,
          (SELECT count(*)::text FROM customers.payment_method_refs WHERE customer_id=$1) methods`,
  [bystander.customerId],
);
assert.equal(bystanderIntact.rows[0]!.email, bystander.email, 'another customer lost personal data');
assert.equal(bystanderIntact.rows[0]!.addresses, '1', 'another customer lost addresses');
assert.equal(bystanderIntact.rows[0]!.methods, '1', 'another customer lost payment methods');

const tombstone = await pool.query<{ count: string }>(
  `SELECT count(*)::text count FROM privacy.erased_customers WHERE customer_id=$1`, [subject.customerId],
);
assert.equal(tombstone.rows[0]!.count, '1', 'the deletion was not recorded');

const consistency = await pool.query<{ manifests: string; dead_letters: string }>(
  `SELECT (SELECT count(*)::text FROM operations.document_manifests) manifests,
          (SELECT count(*)::text FROM operations.dead_letters) dead_letters`,
);
const objectCount: number = await new Promise((resolve, reject) => {
  let total = 0;
  const stream = objectStore.listObjectsV2(DOCUMENT_BUCKET, '', true);
  stream.on('data', () => { total += 1; });
  stream.on('error', reject);
  stream.on('end', () => resolve(total));
});
assert.equal(objectCount, Number(consistency.rows[0]!.manifests), 'stored objects and manifests diverged');
assert.equal(consistency.rows[0]!.dead_letters, '0', 'deletion produced dead letters');

console.log(JSON.stringify({
  status: 'verified', request: completed, erasedCustomer: subject.customerId,
  retainedCustomer: bystander.customerId, retainedFinancials: retained,
}, null, 2));
await pool.end();
