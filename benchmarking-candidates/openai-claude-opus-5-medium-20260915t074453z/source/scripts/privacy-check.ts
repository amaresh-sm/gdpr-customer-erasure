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
  method?: string; body?: unknown; expect?: number; key?: string; headers?: Record<string, string>;
} = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.key ?? apiKey}`,
    ...options.headers,
  };
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${gateway}${path}`, init);
  const payload = await response.json().catch(() => ({})) as T;
  if (options.expect !== undefined && response.status !== options.expect) {
    throw new Error(`${method} ${path}: expected ${options.expect}, received ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function seedCustomer(label: string): Promise<{ customerId: string; email: string; paymentId: string; paymentMethodId: string }> {
  const suffix = `${label}-${randomUUID()}`;
  const email = `privacy-${suffix}@example.test`;
  const customer = await api<{ id: string }>('/v1/customers', {
    method: 'POST', expect: 201,
    body: { externalReference: `privacy-${suffix}`, email, name: `Privacy Subject ${label}`, phone: '+1-415-555-0199', metadata: { segment: 'retail' } },
  });
  await api(`/v1/customers/${customer.id}/addresses`, {
    method: 'POST', expect: 201,
    body: { kind: 'billing', line1: '1 Privacy Way', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US' },
  });
  await api(`/v1/customers/${customer.id}/contacts`, {
    method: 'POST', expect: 201, body: { kind: 'email', value: email, isPrimary: true },
  });
  const method = await api<{ id: string }>(`/v1/customers/${customer.id}/payment-methods`, {
    method: 'POST', expect: 201,
    body: { providerToken: `tok_privacy_${suffix}`, type: 'card', brand: 'visa', last4: '4242', billingName: `Privacy Subject ${label}` },
  });
  await api(`/v1/customers/${customer.id}/support-tickets`, {
    method: 'POST', expect: 201,
    body: { subject: 'Question about my account', body: `Reach me at ${email} or +1-415-555-0199.` },
  });
  await api('/v1/customer-imports', {
    method: 'POST', expect: 201,
    body: { source: 'legacy-crm', record: { customerId: customer.id, email, name: `Privacy Subject ${label}` } },
  });
  await api('/v1/invoices', {
    method: 'POST', expect: 201,
    body: { customerId: customer.id, currency: 'USD', tax: 100, lines: [{ description: 'Subscription', quantity: 1, unitAmount: 4000 }] },
  });
  const payment = await api<{ id: string }>('/v1/payments', {
    method: 'POST', expect: 202, headers: { 'idempotency-key': `privacy-payment-${suffix}` },
    body: { customerId: customer.id, paymentMethodId: method.id, amount: 2500, currency: 'USD', description: `Order for ${label}` },
  });
  return { customerId: customer.id, email, paymentId: payment.id, paymentMethodId: method.id };
}

async function waitForPaymentStatus(paymentId: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const payment = await api<{ status: string }>(`/v1/payments/${paymentId}`);
    if (payment.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`payment ${paymentId} did not reach ${status}`);
}

async function waitForSettledSideEffects(customerId: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const pending = await pool.query<{ count: string }>(
      `SELECT (
         (SELECT count(*) FROM operations.outbox_events WHERE status<>'published')
       + (SELECT count(*) FROM operations.jobs WHERE status NOT IN ('completed','dead'))
       + (SELECT count(*) FROM operations.provider_webhooks WHERE status NOT IN ('processed','dead'))
       + (SELECT count(*) FROM operations.email_deliveries
          WHERE customer_id=$1 AND status NOT IN ('delivered','failed'))
       )::text count`,
      [customerId],
    );
    if (Number(pending.rows[0]!.count) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('asynchronous work did not settle');
}

async function waitForErasure(requestId: string): Promise<ErasureRequest> {
  let last: ErasureRequest | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const request = await api<ErasureRequest>(`/v1/erasure-requests/${requestId}`, { expect: 200 });
    last = request;
    if (request.status === 'completed') return request;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`deletion request did not complete: ${JSON.stringify(last)}`);
}

async function storedObjectKeys(): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    const keys: string[] = [];
    const stream = objectStore.listObjectsV2(DOCUMENT_BUCKET, '', true);
    stream.on('data', (item) => { if (item.name) keys.push(item.name); });
    stream.on('error', reject);
    stream.on('end', () => resolve(keys));
  });
}

async function readStoredObject(objectKey: string): Promise<string> {
  const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const redis = new Redis(config().REDIS_URL);

/**
 * Counts the financial records that must survive deletion. Everything is scoped to the subject's own
 * payments so concurrent activity in the shared environment cannot influence the comparison.
 */
const financialSnapshotQuery = `
  WITH owned AS (SELECT id FROM payments.payment_intents WHERE customer_id=$1),
  entries AS (
    SELECT e.id FROM payments.ledger_entries e
    WHERE e.reference_id IN (SELECT id FROM owned)
       OR e.reference_id IN (SELECT r.id FROM payments.refunds r WHERE r.payment_intent_id IN (SELECT id FROM owned))
  )
  SELECT
    (SELECT count(*)::text FROM owned) payments,
    (SELECT count(*)::text FROM entries) ledger_entries,
    (SELECT count(*)::text FROM payments.ledger_postings p WHERE p.entry_id IN (SELECT id FROM entries)) postings,
    (SELECT coalesce(sum(p.amount),0)::text FROM payments.ledger_postings p
      WHERE p.entry_id IN (SELECT id FROM entries) AND p.direction='debit') debits,
    (SELECT count(*)::text FROM payments.invoices WHERE customer_id=$1) invoices,
    (SELECT count(*)::text FROM payments.captures WHERE payment_intent_id IN (SELECT id FROM owned)) captures,
    (SELECT count(*)::text FROM payments.refunds WHERE payment_intent_id IN (SELECT id FROM owned)) refunds
`;

/** The API contract from `docs/privacy-api.md`. */
async function checkApiContract(): Promise<void> {
  const subject = await seedCustomer('contract');
  const key = `erasure-${randomUUID()}`;

  const accepted = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
    method: 'POST', expect: 202, headers: { 'idempotency-key': key },
  });
  assert.equal(accepted.customerId, subject.customerId, 'response identifies the customer');
  assert.ok(['pending', 'processing', 'completed'].includes(accepted.status), 'accepted request has a workflow status');
  assert.equal(accepted.lastError, null, 'a fresh request reports no error');

  const replay = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
    method: 'POST', expect: 202, headers: { 'idempotency-key': key },
  });
  assert.equal(replay.id, accepted.id, 'reusing a key for the same customer returns the same request');

  const other = await seedCustomer('contract-conflict');
  await api(`/v1/customers/${other.customerId}/erasure-requests`, {
    method: 'POST', expect: 409, headers: { 'idempotency-key': key },
  });

  const newKey = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
    method: 'POST', expect: 202, headers: { 'idempotency-key': `erasure-${randomUUID()}` },
  });
  assert.equal(newKey.id, accepted.id, 'a new key returns the existing request instead of starting another workflow');

  await api(`/v1/customers/${randomUUID()}/erasure-requests`, {
    method: 'POST', expect: 404, headers: { 'idempotency-key': `erasure-${randomUUID()}` },
  });
  await api(`/v1/customers/${subject.customerId}/erasure-requests`, { method: 'POST', expect: 400 });
  await api(`/v1/erasure-requests/${randomUUID()}`, { expect: 404 });

  const completed = await waitForErasure(accepted.id);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt, 'a completed request records when it finished');
  assert.equal(completed.lastError, null);

  // A completed request stays resumable and keeps its identity.
  const afterCompletion = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
    method: 'POST', expect: 202, headers: { 'idempotency-key': `erasure-${randomUUID()}` },
  });
  assert.equal(afterCompletion.id, accepted.id, 'reposting after completion keeps the same request id');
  await waitForErasure(accepted.id);
  console.log(JSON.stringify({ check: 'api_contract', requestId: accepted.id, status: 'ok' }));
}

/** Tenant isolation: a request belongs to the merchant that created it. */
async function checkTenantIsolation(): Promise<void> {
  const subject = await seedCustomer('tenant');
  const request = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
    method: 'POST', expect: 202, headers: { 'idempotency-key': `erasure-${randomUUID()}` },
  });

  await api(`/v1/erasure-requests/${request.id}`, { expect: 404, key: otherApiKey });
  await api(`/v1/customers/${subject.customerId}/erasure-requests`, {
    method: 'POST', expect: 404, key: otherApiKey, headers: { 'idempotency-key': `erasure-${randomUUID()}` },
  });

  const otherMerchantCustomers = await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM customers.customers
     WHERE merchant_id=(SELECT merchant_id FROM platform.api_keys
       WHERE key_hash=encode(digest($1,'sha256'),'hex'))`,
    [otherApiKey],
  );
  await waitForErasure(request.id);
  const afterErasure = await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM customers.customers
     WHERE merchant_id=(SELECT merchant_id FROM platform.api_keys
       WHERE key_hash=encode(digest($1,'sha256'),'hex'))`,
    [otherApiKey],
  );
  assert.equal(afterErasure.rows[0]!.count, otherMerchantCustomers.rows[0]!.count,
    'deletion did not touch the other merchant\'s customers');
  console.log(JSON.stringify({ check: 'tenant_isolation', status: 'ok' }));
}

/** Deletion, retention, and the guarantee that delayed work cannot restore PII. */
async function checkErasureAndRetention(): Promise<void> {
  const subject = await seedCustomer('erasure');
  const bystander = await seedCustomer('bystander');
  await waitForPaymentStatus(subject.paymentId, 'succeeded');
  await waitForPaymentStatus(bystander.paymentId, 'succeeded');
  await api(`/v1/payments/${subject.paymentId}/refunds`, {
    method: 'POST', expect: 202, body: { amount: 500, reason: 'customer requested partial refund' },
  });
  await waitForPaymentStatus(subject.paymentId, 'partially_refunded');
  await waitForSettledSideEffects(subject.customerId);

  const before = await pool.query(financialSnapshotQuery, [subject.customerId]);
  assert.ok(Number(before.rows[0]!.payments) > 0, 'expected retained payment data to verify');
  assert.ok(Number(before.rows[0]!.postings) > 0, 'expected retained ledger postings to verify');

  const request = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
    method: 'POST', expect: 202, headers: { 'idempotency-key': `erasure-${randomUUID()}` },
  });
  const completed = await waitForErasure(request.id);
  assert.equal(completed.status, 'completed');

  // Personal data is gone from the active systems.
  const remaining = await pool.query<Record<string, string>>(
    `SELECT
      (SELECT count(*)::text FROM customers.customers WHERE id=$1) profiles,
      (SELECT count(*)::text FROM customers.addresses WHERE customer_id=$1) addresses,
      (SELECT count(*)::text FROM customers.contacts WHERE customer_id=$1) contacts,
      (SELECT count(*)::text FROM customers.payment_method_refs WHERE customer_id=$1) payment_methods,
      (SELECT count(*)::text FROM customers.provider_customer_mappings WHERE customer_id=$1) provider_mappings,
      (SELECT count(*)::text FROM customers.support_participants WHERE customer_id=$1) support_participation,
      (SELECT count(*)::text FROM customers.support_messages WHERE author_id=$1) support_messages,
      (SELECT count(*)::text FROM operations.analytics_events
        WHERE customer_id=$1 OR anonymous_id='anon_'||$1::text) analytics,
      (SELECT count(*)::text FROM operations.notification_preferences WHERE customer_id=$1) preferences,
      (SELECT count(*)::text FROM operations.notifications WHERE customer_id=$1) notifications,
      (SELECT count(*)::text FROM operations.email_deliveries WHERE customer_id=$1) emails,
      (SELECT count(*)::text FROM provider_sandbox.customers WHERE payflow_customer_id=$1) provider_profiles,
      (SELECT count(*)::text FROM customers.customer_imports i
        WHERE i.merchant_id=(SELECT merchant_id FROM platform.api_keys
          WHERE key_hash=encode(digest($2,'sha256'),'hex'))
        AND EXISTS(SELECT 1 FROM operations.document_manifests d WHERE d.object_key=i.object_key
          AND d.customer_id=$1)) imports`,
    [subject.customerId, apiKey],
  );
  for (const [name, count] of Object.entries(remaining.rows[0]!)) {
    assert.equal(Number(count), 0, `personal data remains in ${name}`);
  }

  // The email address itself must not survive anywhere it is stored as text.
  const addressLeaks = await pool.query<{ source: string }>(
    `SELECT 'email_deliveries' source FROM operations.email_deliveries WHERE destination=$1
     UNION ALL SELECT 'notifications' FROM operations.notifications WHERE destination=$1
     UNION ALL SELECT 'notification_preferences' FROM operations.notification_preferences WHERE destination=$1
     UNION ALL SELECT 'refunds' FROM payments.refunds WHERE customer_email=$1
     UNION ALL SELECT 'analytics_events' FROM operations.analytics_events WHERE email=$1
     UNION ALL SELECT 'payment_intents' FROM payments.payment_intents
       WHERE customer_snapshot::text LIKE '%'||$1||'%'
     UNION ALL SELECT 'invoices' FROM payments.invoices WHERE billing_snapshot::text LIKE '%'||$1||'%'
     UNION ALL SELECT 'outbox_events' FROM operations.outbox_events WHERE payload::text LIKE '%'||$1||'%'
     UNION ALL SELECT 'jobs' FROM operations.jobs WHERE payload::text LIKE '%'||$1||'%'
     UNION ALL SELECT 'audit_logs' FROM platform.audit_logs WHERE metadata::text LIKE '%'||$1||'%'
     UNION ALL SELECT 'dead_letters' FROM operations.dead_letters WHERE payload::text LIKE '%'||$1||'%'
     UNION ALL SELECT 'support_messages' FROM customers.support_messages WHERE body LIKE '%'||$1||'%'
     UNION ALL SELECT 'customer_imports' FROM customers.customer_imports
       WHERE object_key LIKE '%'||$1||'%'`,
    [subject.email],
  );
  assert.deepEqual(addressLeaks.rows.map((row) => row.source), [],
    'the deleted email address still appears in active records');

  // Financial records are retained and still correct.
  const after = await pool.query(financialSnapshotQuery, [subject.customerId]);
  assert.deepEqual(after.rows[0], before.rows[0],
    'financial records must be retained unchanged in count and value');

  const unbalanced = await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM (
       SELECT e.id FROM payments.ledger_entries e JOIN payments.ledger_postings p ON p.entry_id=e.id
       GROUP BY e.id HAVING sum(CASE WHEN p.direction='debit' THEN p.amount ELSE -p.amount END)<>0
     ) invalid`,
  );
  assert.equal(Number(unbalanced.rows[0]!.count), 0, 'ledger must stay balanced');

  const amounts = await pool.query<{ amount: string; currency: string; status: string }>(
    `SELECT amount::text,currency,status FROM payments.payment_intents WHERE id=$1`,
    [subject.paymentId],
  );
  assert.equal(amounts.rows[0]!.amount, '2500', 'retained payment keeps its amount');
  assert.equal(amounts.rows[0]!.currency, 'USD', 'retained payment keeps its currency');
  assert.equal(amounts.rows[0]!.status, 'partially_refunded', 'retained payment keeps its financial status');

  /*
   * Reconciliation is driven by the opaque provider payment id, which deletion must keep. This
   * compares the retained payments against the provider's settlement feed directly rather than
   * starting a run, so the check cannot leave reconciliation state behind for later verification.
   */
  const settlements = await fetch(`${config().PROCESSOR_URL}/v1/settlements`);
  const feed = await settlements.json() as { transactions: { providerPaymentId: string; amount: number }[] };
  const providerAmounts = new Map(feed.transactions.map((item) => [item.providerPaymentId, item.amount]));
  const reconcilable = await pool.query<{ id: string; amount: string; provider_payment_id: string | null }>(
    `SELECT id,amount::text,provider_payment_id FROM payments.payment_intents
     WHERE customer_id=$1 AND status IN ('succeeded','partially_refunded','refunded')`,
    [subject.customerId],
  );
  assert.ok(reconcilable.rowCount, 'expected a retained settled payment to reconcile');
  for (const payment of reconcilable.rows) {
    assert.ok(payment.provider_payment_id,
      'a retained payment lost the provider identifier reconciliation needs');
    assert.equal(providerAmounts.get(payment.provider_payment_id), Number(payment.amount),
      'a retained payment no longer agrees with the provider settlement feed');
  }

  // Projections and object storage no longer expose the customer.
  const cacheKeys = await redis.keys(`*:customer:${subject.customerId}*`);
  assert.deepEqual(cacheKeys, [], 'cache projections still hold the customer');
  const search = await searchClient.search({
    index: CUSTOMER_INDEX, body: { query: { term: { customerId: subject.customerId } } },
  });
  const hits = search.body.hits.total as unknown as { value: number } | number;
  assert.equal(typeof hits === 'number' ? hits : hits.value, 0, 'search projections still hold the customer');

  for (const objectKey of await storedObjectKeys()) {
    const body = await readStoredObject(objectKey);
    assert.ok(!body.includes(subject.email), `stored object ${objectKey} still contains the deleted address`);
  }

  const manifestObjects = await pool.query<{ object_key: string }>(
    `SELECT object_key FROM operations.document_manifests WHERE customer_id=$1`,
    [subject.customerId],
  );
  const storedKeys = new Set(await storedObjectKeys());
  for (const row of manifestObjects.rows) {
    assert.ok(storedKeys.has(row.object_key), `retained manifest ${row.object_key} lost its object`);
  }

  const mail = await fetch(`${config().MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:${subject.email}`)}`);
  const mailbox = await mail.json() as { messages?: unknown[] };
  assert.equal(mailbox.messages?.length ?? 0, 0, 'captured provider email still addresses the deleted customer');

  // The bystander is untouched.
  const untouched = await api<{ id: string; email: string }>(`/v1/customers/${bystander.customerId}`, { expect: 200 });
  assert.equal(untouched.email, bystander.email, 'another customer\'s data was altered');

  console.log(JSON.stringify({ check: 'erasure_and_retention', requestId: request.id, status: 'ok' }));
  return;
}

/** Delayed and replayed work must not bring personal data back. */
async function checkResurrectionResistance(): Promise<void> {
  const subject = await seedCustomer('resurrection');
  await waitForPaymentStatus(subject.paymentId, 'succeeded');
  await waitForSettledSideEffects(subject.customerId);

  const request = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
    method: 'POST', expect: 202, headers: { 'idempotency-key': `erasure-${randomUUID()}` },
  });
  await waitForErasure(request.id);

  // Replay the provider callback and requeue the receipt job that ran before deletion.
  const replayed = await pool.query<{ count: string }>(
    `WITH revived AS (
       UPDATE operations.provider_webhooks
       SET status='pending',next_attempt_at=now(),attempts=0,processed_at=NULL
       WHERE payload->'data'->>'paymentId'=$1 RETURNING id
     ) SELECT count(*)::text count FROM revived`,
    [subject.paymentId],
  );
  const requeued = await pool.query<{ count: string }>(
    `WITH revived AS (
       UPDATE operations.jobs SET status='pending',available_at=now(),attempts=0
       WHERE queue='documents' AND payload->>'paymentId'=$1 RETURNING id
     ) SELECT count(*)::text count FROM revived`,
    [subject.paymentId],
  );
  assert.ok(Number(replayed.rows[0]!.count) + Number(requeued.rows[0]!.count) > 0,
    'expected in-flight work to replay');

  await waitForSettledSideEffects(subject.customerId);
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const restored = await pool.query<{ source: string }>(
    `SELECT 'customers' source FROM customers.customers WHERE id=$1
     UNION ALL SELECT 'email_deliveries' FROM operations.email_deliveries WHERE destination=$2
     UNION ALL SELECT 'notifications' FROM operations.notifications WHERE destination=$2
     UNION ALL SELECT 'analytics_events' FROM operations.analytics_events WHERE email=$2
     UNION ALL SELECT 'payment_intents' FROM payments.payment_intents
       WHERE customer_snapshot::text LIKE '%'||$2||'%'
     UNION ALL SELECT 'jobs' FROM operations.jobs WHERE payload::text LIKE '%'||$2||'%'
     UNION ALL SELECT 'outbox_events' FROM operations.outbox_events WHERE payload::text LIKE '%'||$2||'%'
     UNION ALL SELECT 'provider_sandbox' FROM provider_sandbox.customers WHERE payflow_customer_id=$1`,
    [subject.customerId, subject.email],
  );
  assert.deepEqual(restored.rows.map((row) => row.source), [],
    'replayed work restored the deleted personal data');

  for (const objectKey of await storedObjectKeys()) {
    const body = await readStoredObject(objectKey);
    assert.ok(!body.includes(subject.email), `replayed work rewrote PII into ${objectKey}`);
  }

  const cacheKeys = await redis.keys(`*:customer:${subject.customerId}*`);
  assert.deepEqual(cacheKeys, [], 'replayed work rebuilt the cache projection');

  const status = await api<ErasureRequest>(`/v1/erasure-requests/${request.id}`, { expect: 200 });
  assert.equal(status.status, 'completed', 'a completed request stays completed after replays');

  // New personal data cannot be attached to an erased customer.
  await api(`/v1/customers/${subject.customerId}/contacts`, {
    method: 'POST', expect: 409, body: { kind: 'email', value: subject.email, isPrimary: true },
  });
  await api('/v1/payments', {
    method: 'POST', expect: 422, headers: { 'idempotency-key': `after-erasure-${randomUUID()}` },
    body: { customerId: subject.customerId, paymentMethodId: subject.paymentMethodId, amount: 100, currency: 'USD' },
  });

  console.log(JSON.stringify({ check: 'resurrection_resistance', requestId: request.id, status: 'ok' }));
}

/** A failed request reports a safe error and remains retryable. */
async function checkFailureReporting(): Promise<void> {
  const subject = await seedCustomer('failure');
  const request = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
    method: 'POST', expect: 202, headers: { 'idempotency-key': `erasure-${randomUUID()}` },
  });
  const completed = await waitForErasure(request.id);

  // Force the request back into a failed state to confirm the reported error is a safe code.
  await pool.query(
    `UPDATE privacy.erasure_requests
     SET status='failed',completed_steps='{}',last_error='object_storage_failed',available_at=now()+interval '1 hour'
     WHERE id=$1`,
    [request.id],
  );
  const failed = await api<ErasureRequest>(`/v1/erasure-requests/${request.id}`, { expect: 200 });
  assert.equal(failed.status, 'failed');
  assert.match(failed.lastError ?? '', /^[a-z_]+_failed$/, 'lastError must be a stable code');
  assert.ok(!(failed.lastError ?? '').includes(subject.email), 'lastError must not contain customer data');

  // Reposting makes it runnable again and keeps the same request id.
  const reposted = await api<ErasureRequest>(`/v1/customers/${subject.customerId}/erasure-requests`, {
    method: 'POST', expect: 202, headers: { 'idempotency-key': `erasure-${randomUUID()}` },
  });
  assert.equal(reposted.id, request.id, 'retrying keeps the same request id');
  const recovered = await waitForErasure(request.id);
  assert.equal(recovered.status, 'completed', 'a retried request converges on completion');
  assert.equal(recovered.completedAt !== null, true);
  assert.equal(completed.id, recovered.id);

  console.log(JSON.stringify({ check: 'failure_reporting', requestId: request.id, status: 'ok' }));
}

await checkApiContract();
await checkTenantIsolation();
await checkErasureAndRetention();
await checkResurrectionResistance();
await checkFailureReporting();

console.log(JSON.stringify({ status: 'verified', checks: 5 }, null, 2));
await redis.quit();
await pool.end();
