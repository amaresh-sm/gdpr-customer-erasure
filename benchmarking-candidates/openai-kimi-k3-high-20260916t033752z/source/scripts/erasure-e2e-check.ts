/* Temporary end-to-end verification for customer data deletion. Deleted after use. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Redis } from 'ioredis';

const gateway = 'http://localhost:3000';
const apiKey = 'pf_local_dev_northstar_4ad1539de977';
const secondKey = 'pf_local_dev_bluebird_924bd90d2201';
const CUSTOMER = process.env.ERASE_CUSTOMER_ID!;
const OTHER = process.env.OTHER_CUSTOMER_ID!;
const EMAIL = process.env.ERASE_CUSTOMER_EMAIL!;
const NAME = 'Ada Lovelace';
const PHONE = '+1-415-555-0101';

const pool = new pg.Pool({ connectionString: 'postgres://payflow:payflow@localhost:5432/payflow' });
const redis = new Redis('redis://localhost:6379');

async function api(path: string, method = 'GET', key = apiKey, extra: Record<string, string> = {}, body?: unknown) {
  const headers: Record<string, string> = { ...extra };
  if (key) headers.authorization = `Bearer ${key}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const response = await fetch(`${gateway}${path}`, init);
  let parsed: unknown = null;
  try { parsed = await response.json(); } catch { /* empty */ }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

async function main() {
  // --- auth & validation ---
  let r = await api(`/v1/customers/${CUSTOMER}/erasure-requests`, 'POST', '');
  assert.equal(r.status, 401, 'missing key must be 401');
  r = await api(`/v1/customers/${CUSTOMER}/erasure-requests`, 'POST', apiKey);
  assert.equal(r.status, 400, 'missing idempotency key must be 400');
  r = await api(`/v1/customers/${CUSTOMER}/erasure-requests`, 'POST', apiKey, { 'idempotency-key': 'short' });
  assert.equal(r.status, 400, 'short idempotency key must be 400');
  r = await api(`/v1/customers/${randomUUID()}/erasure-requests`, 'POST', apiKey, { 'idempotency-key': 'k-'.concat(randomUUID()) });
  assert.equal(r.status, 404, 'unknown customer must be 404');
  r = await api(`/v1/customers/${CUSTOMER}/erasure-requests`, 'POST', secondKey, { 'idempotency-key': 'k-'.concat(randomUUID()) });
  assert.equal(r.status, 404, 'cross-merchant customer must be 404');

  // restricted key without privacy:erase scope -> 403
  const restrictedRaw = `pf_restricted_${randomUUID()}`;
  await pool.query(
    `INSERT INTO platform.api_keys(merchant_id,key_hash,label,scopes)
     VALUES('10000000-0000-4000-8000-000000000001',$1,'restricted',ARRAY['customers:read'])`,
    [createHash('sha256').update(restrictedRaw).digest('hex')],
  );
  r = await api(`/v1/customers/${CUSTOMER}/erasure-requests`, 'POST', restrictedRaw, { 'idempotency-key': 'k-'.concat(randomUUID()) });
  assert.equal(r.status, 403, 'missing privacy:erase scope must be 403');

  // --- create request ---
  const key1 = `erase-${randomUUID()}`;
  r = await api(`/v1/customers/${CUSTOMER}/erasure-requests`, 'POST', apiKey, { 'idempotency-key': key1 });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const requestId = String(r.body.id);
  assert.equal(r.body.customerId, CUSTOMER);
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.attempts, 0);
  assert.equal(r.body.completedAt, null);
  assert.equal(r.body.lastError, null);
  assert.ok(typeof r.body.createdAt === 'string' && typeof r.body.updatedAt === 'string');

  // same key + same customer -> same request
  r = await api(`/v1/customers/${CUSTOMER}/erasure-requests`, 'POST', apiKey, { 'idempotency-key': key1 });
  assert.equal(r.status, 202);
  assert.equal(r.body.id, requestId, 'same key must return same request');

  // same key + different customer -> 409
  r = await api(`/v1/customers/${OTHER}/erasure-requests`, 'POST', apiKey, { 'idempotency-key': key1 });
  assert.equal(r.status, 409, 'key reuse across customers must be 409');

  // new key + same customer -> existing request, not a new workflow
  r = await api(`/v1/customers/${CUSTOMER}/erasure-requests`, 'POST', apiKey, { 'idempotency-key': `erase-${randomUUID()}` });
  assert.equal(r.status, 202);
  assert.equal(r.body.id, requestId, 'new key must return the existing request');

  // --- poll until completed ---
  let final: Record<string, unknown> = {};
  for (let i = 0; i < 60; i += 1) {
    const poll = await api(`/v1/erasure-requests/${requestId}`);
    assert.equal(poll.status, 200, JSON.stringify(poll.body));
    final = poll.body;
    if (final.status === 'completed') break;
    if (final.status === 'failed') throw new Error(`erasure failed: ${JSON.stringify(final)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(final.status, 'completed', `request did not complete: ${JSON.stringify(final)}`);
  assert.ok(typeof final.completedAt === 'string');
  assert.equal(final.lastError, null);

  // GET cross-merchant -> 404
  r = await api(`/v1/erasure-requests/${requestId}`, 'GET', secondKey);
  assert.equal(r.status, 404, 'cross-merchant request must be 404');
  r = await api(`/v1/erasure-requests/${randomUUID()}`, 'GET', apiKey);
  assert.equal(r.status, 404, 'unknown request must be 404');

  // repost after completion -> same id, still completed
  r = await api(`/v1/customers/${CUSTOMER}/erasure-requests`, 'POST', apiKey, { 'idempotency-key': `erase-${randomUUID()}` });
  assert.equal(r.status, 202);
  assert.equal(r.body.id, requestId);
  assert.equal(r.body.status, 'completed');

  // --- API surface ---
  r = await api(`/v1/customers/${CUSTOMER}`);
  assert.equal(r.status, 404, 'erased customer must be 404');
  const list = await api('/v1/customers?limit=100');
  const listed = (list.body.data as Array<{ id: string }>).map((c) => c.id);
  assert.ok(!listed.includes(CUSTOMER), 'erased customer must not be listed');
  assert.ok(listed.includes(OTHER), 'other customers must remain listed');

  // mutations on erased customer are blocked
  r = await api(`/v1/customers/${CUSTOMER}/addresses`, 'POST', apiKey, {}, { kind: 'billing', line1: '1 Nowhere', city: 'Nowhere', postalCode: '00000', country: 'US' });
  assert.equal(r.status, 404, 'address add on erased customer must be 404');
  r = await api(`/v1/customers/${CUSTOMER}/contacts`, 'POST', apiKey, {}, { kind: 'email', value: 'x@example.test', isPrimary: true });
  assert.equal(r.status, 404, 'contact add on erased customer must be 404');
  r = await api('/v1/payments', 'POST', apiKey, { 'idempotency-key': `pay-${randomUUID()}` }, { customerId: CUSTOMER, paymentMethodId: randomUUID(), amount: 100, currency: 'USD' });
  assert.ok([404, 409, 422].includes(r.status), `payment for erased customer must be rejected, got ${r.status}`);
  r = await api('/v1/invoices', 'POST', apiKey, {}, { customerId: CUSTOMER, currency: 'USD', lines: [{ description: 'x', quantity: 1, unitAmount: 100 }] });
  assert.ok([404, 422].includes(r.status), `invoice for erased customer must be rejected, got ${r.status}`);

  // --- database: personal data gone, financial facts retained ---
  const q = <T extends pg.QueryResultRow,>(text: string, values: unknown[] = []) => pool.query<T>(text, values);
  const one = async (text: string, values: unknown[] = []) => (await q<{ c: string }>(text, values)).rows[0]!.c;

  const customer = (await q<Record<string, unknown>>(`SELECT * FROM customers.customers WHERE id=$1`, [CUSTOMER])).rows[0]!;
  assert.equal(customer.status, 'erased');
  assert.ok(!String(customer.email).includes('ada'), 'email must be anonymized');
  assert.ok(!String(customer.name).includes('Ada'), 'name must be anonymized');
  assert.equal(customer.phone, null);
  assert.ok(!String(customer.external_reference).includes('crm-ada'), 'external reference must be anonymized');

  assert.equal(await one(`SELECT count(*)::text c FROM customers.addresses WHERE customer_id=$1`, [CUSTOMER]), '0', 'addresses removed');
  assert.equal(await one(`SELECT count(*)::text c FROM customers.contacts WHERE customer_id=$1`, [CUSTOMER]), '0', 'contacts removed');
  assert.equal(await one(`SELECT count(*)::text c FROM customers.payment_method_refs WHERE customer_id=$1`, [CUSTOMER]), '0', 'payment methods removed');
  assert.equal(await one(`SELECT count(*)::text c FROM customers.provider_customer_mappings WHERE customer_id=$1`, [CUSTOMER]), '0', 'provider mappings removed');
  assert.equal(await one(`SELECT count(*)::text c FROM customers.support_participants WHERE customer_id=$1`, [CUSTOMER]), '0', 'support participation removed');
  assert.equal(await one(`SELECT count(*)::text c FROM customers.support_messages WHERE author_id=$1`, [CUSTOMER]), '0', 'support messages removed');
  assert.equal(await one(`SELECT count(*)::text c FROM provider_sandbox.customers WHERE payflow_customer_id=$1`, [CUSTOMER]), '0', 'provider profile removed');
  assert.equal(await one(`SELECT count(*)::text c FROM operations.notification_preferences WHERE customer_id=$1`, [CUSTOMER]), '0', 'notification preferences removed');
  assert.equal(await one(`SELECT count(*)::text c FROM operations.notifications WHERE customer_id=$1`, [CUSTOMER]), '0', 'notifications removed');
  assert.equal(await one(`SELECT count(*)::text c FROM operations.email_deliveries WHERE customer_id=$1`, [CUSTOMER]), '0', 'email deliveries removed');

  // financial records retained but de-identified
  const payments = await q<{ amount: string; status: string; customer_snapshot: Record<string, unknown>; description: string | null }>(
    `SELECT amount,status,customer_snapshot,description FROM payments.payment_intents WHERE customer_id=$1`, [CUSTOMER]);
  assert.ok(payments.rowCount! >= 1, 'payments retained');
  for (const row of payments.rows) {
    assert.ok(Number(row.amount) > 0, 'amount retained');
    assert.deepEqual(row.customer_snapshot, { erased: true }, 'snapshot tombstoned');
    assert.equal(row.description, null, 'description scrubbed');
  }
  assert.equal(await one(`SELECT count(*)::text c FROM payments.refunds r JOIN payments.payment_intents p ON p.id=r.payment_intent_id WHERE p.customer_id=$1 AND r.customer_email IS NOT NULL`, [CUSTOMER]), '0', 'refund emails removed');
  const invoices = await q<{ total: string; billing_snapshot: Record<string, unknown> }>(`SELECT total,billing_snapshot FROM payments.invoices WHERE customer_id=$1`, [CUSTOMER]);
  assert.ok(invoices.rowCount! >= 1, 'invoices retained');
  for (const row of invoices.rows) {
    assert.ok(Number(row.total) > 0, 'invoice total retained');
    assert.deepEqual(row.billing_snapshot, { erased: true }, 'billing snapshot tombstoned');
  }
  const unbalanced = await q<{ c: string }>(
    `SELECT count(*)::text c FROM (
       SELECT e.id FROM payments.ledger_entries e JOIN payments.ledger_postings p ON p.entry_id=e.id
       GROUP BY e.id HAVING sum(CASE WHEN p.direction='debit' THEN p.amount ELSE -p.amount END)<>0) invalid`);
  assert.equal(unbalanced.rows[0]!.c, '0', 'ledger stays balanced');

  // no residual PII anywhere in the database
  const piiNeedles = [EMAIL, NAME, PHONE];
  const tables: Array<[string, string]> = [
    ['customers.customers', "email||name||coalesce(phone,'')||external_reference||metadata::text"],
    ['payments.payment_intents', "customer_snapshot::text||coalesce(description,'')"],
    ['payments.payment_attempts', "request_payload::text||coalesce(response_payload::text,'')"],
    ['payments.refunds', "coalesce(customer_email,'')"],
    ['payments.invoices', "billing_snapshot::text"],
    ['operations.outbox_events', "payload::text"],
    ['operations.jobs', "payload::text"],
    ['operations.dead_letters', "payload::text"],
    ['operations.analytics_events', "coalesce(email,'')||properties::text"],
    ['operations.notifications', "destination||payload::text"],
    ['operations.email_deliveries', "destination||text_body||html_body"],
    ['platform.audit_logs', "metadata::text"],
    ['provider_sandbox.customers', "email||name||external_reference"],
    ['customers.support_messages', "body"],
    ['customers.support_tickets', "subject"],
  ];
  for (const [table, expr] of tables) {
    for (const needle of piiNeedles) {
      const count = await one(`SELECT count(*)::text c FROM ${table} WHERE ${expr} ILIKE $1`, [`%${needle}%`]);
      assert.equal(count, '0', `${table} still contains ${needle}`);
    }
  }

  // operational payloads scrubbed but retained
  const outbox = await q<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM operations.outbox_events WHERE payload->>'customerId'=$1 OR (aggregate_type='customer' AND aggregate_id=$1::uuid)`, [CUSTOMER]);
  assert.ok(outbox.rowCount! >= 1, 'outbox events retained');
  for (const row of outbox.rows) {
    const text = JSON.stringify(row.payload);
    for (const needle of piiNeedles) assert.ok(!text.includes(needle), `outbox payload contains ${needle}: ${text}`);
  }

  // --- projections ---
  const cached = await redis.get(`merchant:10000000-0000-4000-8000-000000000001:customer:${CUSTOMER}`);
  assert.ok(cached, 'redis tombstone retained');
  assert.ok(!cached!.includes(EMAIL) && !cached!.includes(NAME), 'redis tombstone has no PII');
  assert.equal(await redis.get(`merchant:10000000-0000-4000-8000-000000000001:customer:${CUSTOMER}:activity`), null, 'activity hash removed');
  const search = await fetch(`http://localhost:9200/payflow-customers-v1/_doc/10000000-0000-4000-8000-000000000001:${CUSTOMER}`);
  assert.equal(search.status, 200);
  const doc = await search.json() as { _source: Record<string, unknown> };
  assert.equal(doc._source.erased, true, 'opensearch tombstone');
  assert.ok(!JSON.stringify(doc._source).includes(EMAIL), 'opensearch doc has no PII');

  // --- object storage ---
  const manifests = await q<{ object_key: string; document_type: string }>(
    `SELECT object_key,document_type FROM operations.document_manifests WHERE merchant_id='10000000-0000-4000-8000-000000000001'`);
  const minio = await import('minio');
  const store = new minio.Client({ endPoint: 'localhost', port: 9000, useSSL: false, accessKey: 'payflow', secretKey: 'payflow-secret' });
  const objects: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = store.listObjectsV2('payflow-documents', '', true);
    stream.on('data', (item) => { if (item.name) objects.push(item.name); });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const objectCount = objects.length;
  assert.equal(objectCount, manifests.rowCount, 'objects and manifests stay in sync');
  for (const name of objects) {
    const stream = await store.getObject('payflow-documents', name);
    const content = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    for (const needle of piiNeedles) assert.ok(!content.includes(needle), `object ${name} contains ${needle}`);
  }
  assert.ok(!objects.some((name) => name.includes('/imports/') && manifests.rows.every((m) => m.object_key !== name)), 'no orphan import objects');

  // --- other customers unaffected ---
  const other = (await q<Record<string, unknown>>(`SELECT * FROM customers.customers WHERE id=$1`, [OTHER])).rows[0]!;
  assert.equal(other.status, 'active');
  assert.ok(String(other.email).includes('@'), 'other customer data intact');
  assert.ok(Number(await one(`SELECT count(*)::text c FROM customers.addresses WHERE customer_id=$1`, [OTHER])) >= 1, 'other customer addresses intact');
  assert.ok(Number(await one(`SELECT count(*)::text c FROM operations.email_deliveries WHERE customer_id=$1`, [OTHER])) >= 1, 'other customer deliveries intact');

  console.log(JSON.stringify({ status: 'erasure-e2e-verified', requestId, objects: objectCount }));
}

main().then(async () => { await redis.quit(); await pool.end(); })
  .catch(async (error) => { console.error(error); await redis.quit(); await pool.end(); process.exit(1); });
