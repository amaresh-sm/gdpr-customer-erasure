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

interface ErasureRequest {
  id: string;
  customerId: string;
  status: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

async function api<T>(path: string, options: {
  method?: string; body?: unknown; expected?: number; key?: string; headers?: Record<string, string>;
} = {}): Promise<T> {
  const { method = 'GET', body, expected = 200, key = apiKey, headers = {} } = options;
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`, ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json() as T;
  assert.equal(response.status, expected, `${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function readObject(objectKey: string): Promise<string> {
  const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

async function waitFor<T>(description: string, attempt: () => Promise<T | undefined>): Promise<T> {
  for (let tries = 0; tries < 150; tries += 1) {
    const result = await attempt();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Creates a customer with payments, invoices, receipts, support history, and emails to erase. */
async function seedSubject(suffix: string): Promise<{
  customerId: string; email: string; paymentId: string; name: string; externalReference: string;
}> {
  // Every identifying value is unique per subject, so a leak assertion can only match its own subject.
  const email = `erasure-${suffix}@example.test`;
  const name = `Erasure Subject ${suffix}`;
  const externalReference = `crm-erasure-${suffix}`;
  const customer = await api<{ id: string }>('/v1/customers', {
    method: 'POST', expected: 201,
    body: { externalReference, email, name, phone: '+1-415-555-0199', metadata: { segment: 'enterprise' } },
  });
  await api(`/v1/customers/${customer.id}/addresses`, {
    method: 'POST', expected: 201,
    body: { kind: 'billing', line1: '1 Erasure Way', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US' },
  });
  await api(`/v1/customers/${customer.id}/contacts`, {
    method: 'POST', expected: 201, body: { kind: 'email', value: email, isPrimary: true },
  });
  const method = await api<{ id: string }>(`/v1/customers/${customer.id}/payment-methods`, {
    method: 'POST', expected: 201,
    body: { providerToken: `tok_erasure_${suffix}`, type: 'card', brand: 'visa', last4: '4242', billingName: name },
  });
  await api(`/v1/customers/${customer.id}/support-tickets`, {
    method: 'POST', expected: 201,
    body: { subject: 'Erasure subject question', body: `Please reach me at ${email}.` },
  });
  await api('/v1/customer-imports', {
    method: 'POST', expected: 201,
    body: { source: 'legacy-crm', record: { customerId: customer.id, email, name, externalReference } },
  });
  await api('/v1/invoices', {
    method: 'POST', expected: 201,
    body: { customerId: customer.id, currency: 'USD', tax: 100, lines: [{ description: 'Subscription', quantity: 1, unitAmount: 4900 }] },
  });
  const payment = await api<{ id: string }>('/v1/payments', {
    method: 'POST', expected: 202, headers: { 'idempotency-key': `erasure-payment-${suffix}` },
    body: { customerId: customer.id, paymentMethodId: method.id, amount: 3300, currency: 'USD', description: 'Erasure subject order' },
  });
  return { customerId: customer.id, email, paymentId: payment.id, name, externalReference };
}

const suffix = randomUUID().slice(0, 8);
const subject = await seedSubject(suffix);
// An unrelated suffix, so no identifying value of one subject is a substring of the other's.
const bystander = await seedSubject(randomUUID().slice(0, 8));

// The scenario is only meaningful once the asynchronous pipelines have written the data to erase.
await waitFor('subject payment to be captured with a receipt and email', async () => {
  const state = await pool.query<{ receipts: string; emails: string; projections: string }>(
    `SELECT
       (SELECT count(*) FROM operations.document_manifests
        WHERE customer_id=$1 AND document_type='receipt')::text receipts,
       (SELECT count(*) FROM operations.email_deliveries WHERE customer_id=$1 AND status='delivered')::text emails,
       (SELECT count(*) FROM operations.analytics_events WHERE customer_id=$1)::text projections`,
    [subject.customerId],
  );
  const row = state.rows[0]!;
  return Number(row.receipts) > 0 && Number(row.emails) > 0 && Number(row.projections) > 0 ? row : undefined;
});

const objectKeys = (await pool.query<{ object_key: string }>(
  `SELECT object_key FROM operations.document_manifests WHERE merchant_id=(
     SELECT merchant_id FROM payments.payment_intents WHERE id=$1)`,
  [subject.paymentId],
)).rows.map((row) => row.object_key);

const requestKey = `erasure-request-${suffix}`;
const accepted = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
  method: 'POST', expected: 202, headers: { 'idempotency-key': requestKey },
});
assert.equal(accepted.customerId, subject.customerId, 'accepted request names the wrong customer');
assert.ok(['pending', 'processing', 'completed'].includes(accepted.status), `unexpected initial status ${accepted.status}`);
assert.equal(accepted.completedAt, null, 'a newly accepted request is not complete');

const replayed = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
  method: 'POST', expected: 202, headers: { 'idempotency-key': requestKey },
});
assert.equal(replayed.id, accepted.id, 'replaying the idempotency key started a second request');

await api(`/v1/customers/${bystander.customerId}/erasure-requests`, {
  method: 'POST', expected: 409, headers: { 'idempotency-key': requestKey },
});

const resumed = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
  method: 'POST', expected: 202, headers: { 'idempotency-key': `erasure-request-new-${suffix}` },
});
assert.equal(resumed.id, accepted.id, 'a new idempotency key started a second workflow for the same customer');

const completed = await waitFor('the deletion request to complete', async () => {
  const request = await api<ErasureRequest>(`/v1/erasure-requests/${accepted.id}`);
  assert.notEqual(request.status, 'failed', `deletion failed: ${request.lastError}`);
  return request.status === 'completed' ? request : undefined;
});
assert.ok(completed.completedAt, 'a completed request reports when it completed');
assert.equal(completed.lastError, null, 'a completed request reports no error');

await api(`/v1/erasure-requests/${accepted.id}`, { expected: 404, key: otherApiKey });
await api(`/v1/customers/${subject.customerId}/erasure-requests`, {
  method: 'POST', expected: 404, key: otherApiKey, headers: { 'idempotency-key': `cross-tenant-${suffix}` },
});
await api(`/v1/erasure-requests/${randomUUID()}`, { expected: 404 });
await api(`/v1/customers/${randomUUID()}/erasure-requests`, {
  method: 'POST', expected: 404, headers: { 'idempotency-key': `unknown-customer-${suffix}` },
});

await api(`/v1/customers/${subject.customerId}`, { expected: 404 });

/*
 * Replaying the whole event topic and re-delivering provider callbacks is the strongest available
 * test that delayed work cannot restore the deleted data: the assertions below run afterwards.
 */
await pool.query(
  `UPDATE operations.inbox_events SET status='pending',processed_at=NULL
   WHERE event_id IN (SELECT id FROM operations.outbox_events WHERE merchant_id=(
     SELECT merchant_id FROM payments.payment_intents WHERE id=$1))`,
  [subject.paymentId],
);
await pool.query(
  `UPDATE operations.provider_webhooks SET status='retry',next_attempt_at=now(),attempts=0,processed_at=NULL
   WHERE payload->'data'->>'paymentId'=$1`,
  [subject.paymentId],
);
await pool.query(
  `UPDATE provider_sandbox.payment_intents
   SET webhook_delivered_at=NULL,next_delivery_at=now(),webhook_attempts=0 WHERE payment_id=$1`,
  [subject.paymentId],
);
await new Promise((resolve) => setTimeout(resolve, 6_000));
await waitFor('replayed provider and event work to settle', async () => {
  const pending = await pool.query<{ count: string }>(
    `SELECT ((SELECT count(*) FROM operations.provider_webhooks WHERE status NOT IN ('processed','dead'))
      + (SELECT count(*) FROM provider_sandbox.payment_intents WHERE webhook_delivered_at IS NULL))::text count`,
  );
  return pending.rows[0]!.count === '0' ? true : undefined;
});

const leaks = await pool.query<{
  customers: string; addresses: string; contacts: string; payment_methods: string;
  provider_mappings: string; notification_preferences: string; notifications: string; emails: string;
  support_messages: string; support_participants: string; analytics_identity: string;
  payment_identity: string; invoice_identity: string; refund_identity: string; audit_identity: string;
  outbox_identity: string; sandbox_identity: string; tombstones: string; steps: string;
}>(`
  SELECT
    (SELECT count(*) FROM customers.customers WHERE id=$1)::text customers,
    (SELECT count(*) FROM customers.addresses WHERE customer_id=$1)::text addresses,
    (SELECT count(*) FROM customers.contacts WHERE customer_id=$1)::text contacts,
    (SELECT count(*) FROM customers.payment_method_refs WHERE customer_id=$1)::text payment_methods,
    (SELECT count(*) FROM customers.provider_customer_mappings WHERE customer_id=$1)::text provider_mappings,
    (SELECT count(*) FROM operations.notification_preferences WHERE customer_id=$1)::text notification_preferences,
    (SELECT count(*) FROM operations.notifications WHERE customer_id=$1)::text notifications,
    (SELECT count(*) FROM operations.email_deliveries WHERE customer_id=$1 OR destination=$2)::text emails,
    (SELECT count(*) FROM customers.support_messages WHERE author_id=$1 OR body LIKE '%'||$2||'%')::text support_messages,
    (SELECT count(*) FROM customers.support_participants WHERE customer_id=$1)::text support_participants,
    (SELECT count(*) FROM operations.analytics_events
      WHERE customer_id=$1 AND (email IS NOT NULL OR properties::text LIKE '%'||$2||'%'))::text analytics_identity,
    (SELECT count(*) FROM payments.payment_intents
      WHERE customer_id=$1 AND customer_snapshot::text LIKE '%'||$2||'%')::text payment_identity,
    (SELECT count(*) FROM payments.invoices
      WHERE customer_id=$1 AND billing_snapshot::text LIKE '%'||$2||'%')::text invoice_identity,
    (SELECT count(*) FROM payments.refunds WHERE customer_email=$2)::text refund_identity,
    (SELECT count(*) FROM platform.audit_logs
      WHERE target_id=$1::text AND metadata::text LIKE '%'||$2||'%')::text audit_identity,
    (SELECT count(*) FROM operations.outbox_events WHERE payload::text LIKE '%'||$2||'%')::text outbox_identity,
    (SELECT count(*) FROM provider_sandbox.customers
      WHERE payflow_customer_id=$1 AND (email=$2 OR external_reference=$3))::text sandbox_identity,
    (SELECT count(*) FROM privacy.erased_customers WHERE customer_id=$1)::text tombstones,
    (SELECT count(*) FROM privacy.erasure_steps WHERE request_id=$4)::text steps
`, [subject.customerId, subject.email, subject.externalReference, accepted.id]);
for (const [table, count] of Object.entries(leaks.rows[0]!)) {
  if (table === 'tombstones') continue;
  assert.equal(Number(count), 0, `${table} still holds data for the erased customer`);
}
assert.equal(Number(leaks.rows[0]!.tombstones), 1, 'the retained deletion record is missing');

const nameLeaks = await pool.query<{ count: string }>(
  `SELECT ((SELECT count(*) FROM payments.payment_intents
      WHERE customer_id=$1 AND customer_snapshot::text LIKE '%'||$2||'%')
    + (SELECT count(*) FROM payments.invoices
      WHERE customer_id=$1 AND billing_snapshot::text LIKE '%'||$2||'%'))::text count`,
  [subject.customerId, subject.name],
);
assert.equal(Number(nameLeaks.rows[0]!.count), 0, 'retained financial records still name the erased customer');

// Financial records must survive the deletion with their monetary facts intact.
const retained = await pool.query<{
  status: string; amount: string; currency: string; captures: string; invoices: string;
  invoice_total: string | null; unbalanced: string;
}>(`
  SELECT p.status,p.amount::text,p.currency,
    (SELECT count(*) FROM payments.captures c WHERE c.payment_intent_id=p.id AND c.status='succeeded')::text captures,
    (SELECT count(*) FROM payments.invoices i WHERE i.customer_id=p.customer_id)::text invoices,
    (SELECT sum(i.total)::text FROM payments.invoices i WHERE i.customer_id=p.customer_id) invoice_total,
    (SELECT count(*) FROM (
      SELECT e.id FROM payments.ledger_entries e JOIN payments.ledger_postings l ON l.entry_id=e.id
      WHERE e.reference_id=p.id GROUP BY e.id
      HAVING sum(CASE WHEN l.direction='debit' THEN l.amount ELSE -l.amount END)<>0
    ) invalid)::text unbalanced
  FROM payments.payment_intents p WHERE p.id=$1
`, [subject.paymentId]);
const financial = retained.rows[0];
assert.ok(financial, 'the retained payment record was deleted');
assert.equal(financial.status, 'succeeded', 'the retained payment lost its status');
assert.equal(financial.amount, '3300', 'the retained payment lost its amount');
assert.equal(financial.currency, 'USD', 'the retained payment lost its currency');
assert.equal(Number(financial.captures), 1, 'the retained payment lost its capture');
assert.equal(Number(financial.invoices), 1, 'the retained invoice was deleted');
assert.equal(Number(financial.invoice_total), 5000, 'the retained invoice lost its total');
assert.equal(Number(financial.unbalanced), 0, 'the ledger no longer balances for the retained payment');

for (const objectKey of objectKeys) {
  let document: string;
  try { document = await readObject(objectKey); }
  catch (error) {
    if ((error as { code?: string }).code === 'NoSuchKey') continue;
    throw error;
  }
  assert.ok(!document.includes(subject.email), `stored object ${objectKey} still contains the erased email`);
  assert.ok(!document.includes(subject.name), `stored object ${objectKey} still contains the erased name`);
  assert.ok(
    !document.includes(subject.externalReference),
    `stored object ${objectKey} still contains the erased external reference`,
  );
}

const searchHits = await searchClient.search({
  index: CUSTOMER_INDEX, body: { query: { term: { customerId: subject.customerId } } },
});
assert.equal(
  searchHits.body.hits.hits.length, 0, 'the search index still exposes the erased customer',
);

const redis = new Redis(config().REDIS_URL);
const cachedKeys = await redis.keys(`merchant:*:customer:${subject.customerId}*`);
assert.deepEqual(cachedKeys, [], 'the cache still holds the erased customer');

const mailbox = await fetch(
  `${config().MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:${subject.email}`)}`,
);
assert.ok(mailbox.ok, `mailbox search failed (${mailbox.status})`);
const messages = await mailbox.json() as { messages?: unknown[] };
assert.equal(messages.messages?.length ?? 0, 0, 'delivered mail still addresses the erased customer');

// A deletion must not touch anyone else's data.
const untouched = await pool.query<{ customers: string; payments: string; emails: string }>(`
  SELECT
    (SELECT count(*) FROM customers.customers WHERE id=$1)::text customers,
    (SELECT count(*) FROM payments.payment_intents
      WHERE customer_id=$1 AND customer_snapshot->>'email'=$2)::text payments,
    (SELECT count(*) FROM operations.email_deliveries WHERE customer_id=$1)::text emails
`, [bystander.customerId, bystander.email]);
assert.equal(Number(untouched.rows[0]!.customers), 1, 'another customer was deleted');
assert.equal(Number(untouched.rows[0]!.payments), 1, 'another customer lost their payment snapshot');
assert.ok(Number(untouched.rows[0]!.emails) > 0, 'another customer lost their email records');

const bystanderView = await api<{ id: string; email: string }>(`/v1/customers/${bystander.customerId}`);
assert.equal(bystanderView.email, bystander.email, 'another customer is no longer readable');

/*
 * Finally, simulate a worker that died mid-cleanup by expiring the lease of the finished request.
 * Recovery must converge on the same result rather than duplicating destructive work.
 */
const financialBefore = await pool.query<{ payments: string; invoices: string; postings: string }>(`
  SELECT
    (SELECT count(*) FROM payments.payment_intents WHERE customer_id=$1)::text payments,
    (SELECT count(*) FROM payments.invoices WHERE customer_id=$1)::text invoices,
    (SELECT count(*) FROM payments.ledger_postings)::text postings
`, [subject.customerId]);
await pool.query(
  `UPDATE privacy.erasure_requests
   SET status='processing',completed_at=NULL,locked_by='crashed-worker',locked_at=now()-interval '5 minutes',
       lease_expires_at=now()-interval '4 minutes' WHERE id=$1`,
  [accepted.id],
);
const resumedRequest = await waitFor('the abandoned request to recover', async () => {
  const request = await api<ErasureRequest>(`/v1/erasure-requests/${accepted.id}`);
  return request.status === 'completed' ? request : undefined;
});
assert.equal(resumedRequest.id, accepted.id, 'recovery changed the request id');
assert.equal(resumedRequest.lastError, null, 'the recovered request still reports an error');

const financialAfter = await pool.query<{ payments: string; invoices: string; postings: string; tombstones: string }>(`
  SELECT
    (SELECT count(*) FROM payments.payment_intents WHERE customer_id=$1)::text payments,
    (SELECT count(*) FROM payments.invoices WHERE customer_id=$1)::text invoices,
    (SELECT count(*) FROM payments.ledger_postings)::text postings,
    (SELECT count(*) FROM privacy.erased_customers WHERE customer_id=$1)::text tombstones
`, [subject.customerId]);
assert.equal(financialAfter.rows[0]!.payments, financialBefore.rows[0]!.payments, 'recovery changed retained payments');
assert.equal(financialAfter.rows[0]!.invoices, financialBefore.rows[0]!.invoices, 'recovery changed retained invoices');
assert.equal(financialAfter.rows[0]!.postings, financialBefore.rows[0]!.postings, 'recovery altered the append-only ledger');
assert.equal(Number(financialAfter.rows[0]!.tombstones), 1, 'recovery duplicated the retained deletion record');

console.log(JSON.stringify({
  status: 'verified',
  requestId: accepted.id,
  customerId: subject.customerId,
  retainedPayment: { id: subject.paymentId, status: financial.status, amount: Number(financial.amount) },
  inspectedObjects: objectKeys.length,
}, null, 2));
await redis.quit();
await pool.end();
