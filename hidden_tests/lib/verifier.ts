import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DOCUMENT_BUCKET, CUSTOMER_INDEX, kafka, minio, pool, redis, search, settings } from './clients.js';
import { api, poll } from './http.js';
import type { BenchmarkFixture, MerchantApiKeySnapshot, SubjectFixture } from './fixture.js';

interface ErasureResponse {
  id: string;
  customerId: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  lastError?: string | null;
  steps?: Array<{ participant: string; status: string }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function needles(subject: SubjectFixture): string[] {
  return [subject.customerId, subject.email, subject.name, subject.phone, subject.externalReference, subject.canary];
}

function needleHits(value: unknown, subject: SubjectFixture,
                    allowed: ReadonlySet<string> = new Set()): string[] {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const labels = ['customer UUID', 'email', 'name', 'phone', 'external reference', 'PII canary'];
  return needles(subject).flatMap((needle, index) => !allowed.has(needle) &&
    serialized.toLowerCase().includes(needle.toLowerCase()) ? [labels[index]!] : []);
}

export async function verifyRequestContract(fixture: BenchmarkFixture): Promise<string> {
  const unknown = randomUUID();
  await api(fixture.merchantKey, `/v1/customers/${unknown}/erasure-requests`, {
    method: 'POST', expected: 404, headers: { 'idempotency-key': `unknown-${fixture.slot}` },
  });

  await api(fixture.otherMerchantKey, `/v1/customers/${fixture.normal.customerId}/erasure-requests`, {
    method: 'POST', expected: 404, headers: { 'idempotency-key': `cross-tenant-${fixture.slot}` },
  });
  const winningKey = `erase-canonical-${fixture.slot}`;
  const keys = [winningKey, winningKey, winningKey];
  const concurrent = await Promise.all(keys.map(async (key) => await api<ErasureResponse>(
    fixture.merchantKey, `/v1/customers/${fixture.normal.customerId}/erasure-requests`,
    { method: 'POST', expected: 202, headers: { 'idempotency-key': key } },
  )));
  const requestIds = new Set(concurrent.map((response) => response.body.id));
  assert(requestIds.size === 1, 'concurrent erasure requests created multiple workflows');
  const requestId = concurrent[0]!.body.id;
  const alternate = await api<ErasureResponse>(fixture.merchantKey,
    `/v1/customers/${fixture.normal.customerId}/erasure-requests`,
    { method: 'POST', expected: 202, headers: { 'idempotency-key': `erase-alternate-${fixture.slot}` } });
  assert(alternate.body.id === requestId, 'alternate key created a second customer workflow');
  const repeated = await api<ErasureResponse>(fixture.merchantKey,
    `/v1/customers/${fixture.normal.customerId}/erasure-requests`,
    { method: 'POST', expected: 202, headers: { 'idempotency-key': winningKey } });
  assert(repeated.body.id === requestId, 'idempotent retry changed request id');
  await api(fixture.merchantKey, `/v1/customers/${fixture.survivor.customerId}/erasure-requests`, {
    method: 'POST', expected: 409, headers: { 'idempotency-key': winningKey },
  });
  return requestId;
}

export async function requestErasure(apiKey: string, customerId: string, idempotencyKey: string): Promise<string> {
  const response = await api<ErasureResponse>(apiKey, `/v1/customers/${customerId}/erasure-requests`, {
    method: 'POST', expected: 202, headers: { 'idempotency-key': idempotencyKey },
  });
  return response.body.id;
}

export async function waitForCompletion(apiKey: string, requestId: string): Promise<ErasureResponse> {
  return await poll(async () => (await api<ErasureResponse>(apiKey, `/v1/erasure-requests/${requestId}`,
    { expected: 200 })).body, (body) => body.status === 'completed', `erasure request ${requestId}`, 160);
}

export async function waitForStatus(apiKey: string, requestId: string,
                                    status: ErasureResponse['status']): Promise<ErasureResponse> {
  return await poll(async () => (await api<ErasureResponse>(apiKey, `/v1/erasure-requests/${requestId}`,
    { expected: 200 })).body, (body) => body.status === status, `erasure request ${requestId} to become ${status}`, 160);
}

/** Proves that every store claimed by the verifier actually contains the fixture subject before erasure. */
export async function verifyFixtureCoverage(fixture: BenchmarkFixture): Promise<void> {
  const subject = fixture.normal;
  const relational = await pool.query<{ customers: string; addresses: string; contacts: string; methods: string; payments: string; invoices: string }>(
    `SELECT
       (SELECT count(*)::text FROM customers.customers WHERE merchant_id=$1 AND id=$2) customers,
       (SELECT count(*)::text FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2) addresses,
       (SELECT count(*)::text FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2) contacts,
       (SELECT count(*)::text FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2) methods,
       (SELECT count(*)::text FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2) payments,
       (SELECT count(*)::text FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2) invoices`,
    [fixture.merchantId, subject.customerId],
  );
  const row = relational.rows[0];
  assert(row !== undefined && Object.values(row).every((count) => Number(count) > 0),
    'fixture did not create every expected PostgreSQL relation');

  const postgresPayloads = await pool.query<Record<string, unknown>>(
    `SELECT
       (SELECT to_jsonb(c) FROM customers.customers c WHERE c.merchant_id=$1 AND c.id=$2) customer,
       (SELECT to_jsonb(t) FROM customers.support_tickets t WHERE t.merchant_id=$1 AND t.id=$3) support_ticket,
       (SELECT to_jsonb(m) FROM customers.support_messages m
          WHERE m.merchant_id=$1 AND m.ticket_id=$3 AND m.author_id=$2 ORDER BY m.id LIMIT 1) support_message,
       (SELECT jsonb_build_object('intent',to_jsonb(p),'attempt',to_jsonb(a))
          FROM payments.payment_intents p JOIN payments.payment_attempts a ON a.payment_intent_id=p.id
          WHERE p.merchant_id=$1 AND p.id=$4 ORDER BY a.id LIMIT 1) payment_attempt,
       (SELECT jsonb_build_object('invoice',to_jsonb(i),'line',to_jsonb(l))
          FROM payments.invoices i JOIN payments.invoice_lines l ON l.invoice_id=i.id
          WHERE i.merchant_id=$1 AND i.id=$5 ORDER BY l.id LIMIT 1) invoice_line`,
    [fixture.merchantId, subject.customerId, subject.ticketId, subject.paymentId, subject.invoiceId],
  );
  const payloadRow = postgresPayloads.rows[0];
  assert(payloadRow !== undefined && Object.values(payloadRow)
    .every((value) => value !== null && needleHits(value, subject).length > 0),
  'fixture did not create PII in every claimed PostgreSQL payload surface');

  const cache = await redis.get(`merchant:${fixture.merchantId}:customer:${subject.customerId}`);
  assert(cache !== null && needleHits(cache, subject).length > 0, 'fixture did not create a Redis PII projection');

  const document = await search.get({ index: CUSTOMER_INDEX, id: `${fixture.merchantId}:${subject.customerId}` });
  const source = (document.body as { _source?: unknown })._source;
  assert(source !== undefined && needleHits(source, subject).length > 0,
    'fixture did not create an OpenSearch PII projection');

  let minioPiiFound = false;
  for (const objectName of await listObjectNames(`${fixture.merchantId}/`)) {
    const object = await minio.getObject(DOCUMENT_BUCKET, objectName);
    if (needleHits(`${objectName}\n${await streamText(object)}`, subject).length > 0) {
      minioPiiFound = true;
      break;
    }
  }
  assert(minioPiiFound, 'fixture did not create a MinIO object containing subject PII');

  const mailpit = await fetch(`${settings.mailpit}/api/v1/search?query=${encodeURIComponent(subject.email)}`);
  assert(mailpit.ok, `fixture Mailpit search failed: ${mailpit.status}`);
  const mailpitBody = await mailpit.json() as { messages_count?: number; messages?: unknown[] };
  assert((mailpitBody.messages_count ?? mailpitBody.messages?.length ?? 0) > 0,
    'fixture did not create a Mailpit message containing subject PII');

  const delayed = await pool.query<{ jobs: string; webhooks: string; deliveries: string; dead_letters: string }>(
    `SELECT
       (SELECT count(*)::text FROM operations.jobs WHERE id=$1) jobs,
       (SELECT count(*)::text FROM operations.provider_webhooks WHERE id=$2) webhooks,
       (SELECT count(*)::text FROM operations.email_deliveries WHERE id=$3) deliveries,
       (SELECT count(*)::text FROM operations.dead_letters WHERE source_id=$1::text) dead_letters`,
    [fixture.delayedJobId, fixture.delayedWebhookId, fixture.delayedEmailDeliveryId],
  );
  const delayedRow = delayed.rows[0];
  assert(delayedRow !== undefined && Object.values(delayedRow).every((count) => Number(count) > 0),
    'fixture did not create every delayed-work PII surface');

  const delayedPayloads = await pool.query<Record<string, unknown>>(
    `SELECT
       (SELECT to_jsonb(j) FROM operations.jobs j WHERE j.id=$1) job,
       (SELECT to_jsonb(a) FROM payments.payment_attempts a WHERE a.payment_intent_id=$2 ORDER BY a.id LIMIT 1) payment_attempt,
       (SELECT to_jsonb(d) FROM operations.email_deliveries d WHERE d.id=$3) delivery,
       (SELECT to_jsonb(l) FROM operations.dead_letters l WHERE l.source_id=$1::text ORDER BY l.id LIMIT 1) dead_letter`,
    [fixture.delayedJobId, fixture.delayed.paymentId, fixture.delayedEmailDeliveryId],
  );
  const delayedPayloadRow = delayedPayloads.rows[0];
  assert(delayedPayloadRow !== undefined && Object.values(delayedPayloadRow)
    .every((value) => value !== null && needleHits(value, fixture.delayed).length > 0),
  'fixture did not create PII in every claimed delayed-work payload surface');
}

/** Confirms that a rejected tenant-boundary probe left the target customer untouched. */
export async function verifySubjectUnchanged(fixture: BenchmarkFixture, subject: SubjectFixture): Promise<void> {
  const customer = await pool.query<{ email: string; name: string; phone: string; external_reference: string }>(
    `SELECT email,name,phone,external_reference FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
    [fixture.merchantId, subject.customerId],
  );
  const row = customer.rows[0];
  assert(row?.email === subject.email && row.name === subject.name && row.phone === subject.phone &&
    row.external_reference === subject.externalReference, 'tenant-boundary probe changed the target customer');
  const related = await pool.query<{ addresses: string; contacts: string; methods: string; payments: string; invoices: string }>(
    `SELECT
       (SELECT count(*)::text FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2) addresses,
       (SELECT count(*)::text FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2) contacts,
       (SELECT count(*)::text FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2) methods,
       (SELECT count(*)::text FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2) payments,
       (SELECT count(*)::text FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2) invoices`,
    [fixture.merchantId, subject.customerId],
  );
  assert(related.rows[0] !== undefined && Object.values(related.rows[0]).every((count) => Number(count) > 0),
    'tenant-boundary probe removed a target relationship');
}

const transientFaultFunction = 'operations.hidden_test_fail_payment_erasure';
const transientFaultTrigger = 'hidden_test_fail_payment_erasure';

/** Installs a one-purpose, temporary database fault at the retained-payment write boundary. */
export async function installTransientPaymentWriteFailure(paymentId: string): Promise<void> {
  await removeTransientPaymentWriteFailure();
  await pool.query(`CREATE FUNCTION ${transientFaultFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='temporary_hidden_test_payment_write_failure'; END;
  $$`);
  await pool.query(`CREATE TRIGGER ${transientFaultTrigger}
    BEFORE UPDATE OR DELETE ON payments.payment_intents
    FOR EACH ROW WHEN (OLD.id = '${paymentId}'::uuid)
    EXECUTE FUNCTION ${transientFaultFunction}()`);
}

/** Removes the isolated fault so the same durable request can resume. */
export async function removeTransientPaymentWriteFailure(): Promise<void> {
  await pool.query(`DROP TRIGGER IF EXISTS ${transientFaultTrigger} ON payments.payment_intents`);
  await pool.query(`DROP FUNCTION IF EXISTS ${transientFaultFunction}()`);
}

async function collectPostgresViolations(fixture: BenchmarkFixture, subject: SubjectFixture): Promise<string[]> {
  const violations: string[] = [];
  const checks = await pool.query<{ source: string; hits: string }>(
    `SELECT 'customers' source,count(*)::text hits FROM customers.customers WHERE merchant_id=$1 AND id=$2
     UNION ALL SELECT 'addresses',count(*)::text FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2
     UNION ALL SELECT 'contacts',count(*)::text FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2
     UNION ALL SELECT 'methods',count(*)::text FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2
     UNION ALL SELECT 'participants',count(*)::text FROM customers.support_participants WHERE customer_id=$2
     UNION ALL SELECT 'payment-link',count(*)::text FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
     UNION ALL SELECT 'invoice-link',count(*)::text FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2
     UNION ALL SELECT 'analytics-link',count(*)::text FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2
     UNION ALL SELECT 'preference-link',count(*)::text FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2
     UNION ALL SELECT 'notification-link',count(*)::text FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2
     UNION ALL SELECT 'manifest-link',count(*)::text FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`,
    [fixture.merchantId, subject.customerId],
  );
  for (const check of checks.rows) {
    if (check.hits !== '0') violations.push(`${check.source} retained ${check.hits} direct subject link(s)`);
  }

  const payloads = await pool.query<{ source: string; value: unknown }>(
    `SELECT 'audit' source,to_jsonb(a) value FROM platform.audit_logs a WHERE merchant_id=$1
     UNION ALL SELECT 'support',to_jsonb(m) FROM customers.support_messages m WHERE merchant_id=$1
     UNION ALL SELECT 'payments',to_jsonb(p) FROM payments.payment_intents p WHERE merchant_id=$1
     UNION ALL SELECT 'attempts',to_jsonb(a) FROM payments.payment_attempts a WHERE merchant_id=$1
     UNION ALL SELECT 'refunds',to_jsonb(r) FROM payments.refunds r WHERE merchant_id=$1
     UNION ALL SELECT 'disputes',to_jsonb(d) FROM payments.disputes d WHERE merchant_id=$1
     UNION ALL SELECT 'invoices',to_jsonb(i) FROM payments.invoices i WHERE merchant_id=$1
     UNION ALL SELECT 'invoice-lines',to_jsonb(l) FROM payments.invoice_lines l JOIN payments.invoices i ON i.id=l.invoice_id WHERE i.merchant_id=$1
     UNION ALL SELECT 'outbox',to_jsonb(o) FROM operations.outbox_events o WHERE merchant_id=$1
     UNION ALL SELECT 'jobs',to_jsonb(j) FROM operations.jobs j WHERE merchant_id=$1
     UNION ALL SELECT 'dead-letters',to_jsonb(d) FROM operations.dead_letters d
     UNION ALL SELECT 'idempotency',to_jsonb(k) FROM operations.idempotency_keys k WHERE merchant_id=$1
     UNION ALL SELECT 'analytics',to_jsonb(a) FROM operations.analytics_events a WHERE merchant_id=$1
     UNION ALL SELECT 'preferences',to_jsonb(p) FROM operations.notification_preferences p WHERE merchant_id=$1
     UNION ALL SELECT 'notifications',to_jsonb(n) FROM operations.notifications n WHERE merchant_id=$1
     UNION ALL SELECT 'manifests',to_jsonb(m) FROM operations.document_manifests m WHERE merchant_id=$1`, [fixture.merchantId],
  );
  for (const row of payloads.rows) {
    const hits = needleHits(row.value, subject);
    if (hits.length > 0) violations.push(`PostgreSQL ${row.source} retained ${hits.join(', ')}`);
  }

  const applicationTables = await pool.query<{ schemaname: string; tablename: string }>(
    `SELECT schemaname,tablename FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
  );
  const humanNeedles = [subject.email, subject.name, subject.phone, subject.externalReference, subject.canary];
  for (const table of applicationTables.rows) {
    const schema = table.schemaname.replaceAll('"', '""');
    const name = table.tablename.replaceAll('"', '""');
    const result = await pool.query<{ hits: string }>(
      `SELECT count(*)::text hits FROM "${schema}"."${name}" row_value
       WHERE ${humanNeedles.map((_, index) => `lower(to_jsonb(row_value)::text) LIKE lower($${index + 1})`).join(' OR ')}`,
      humanNeedles.map((needle) => `%${needle}%`),
    );
    if (result.rows[0]?.hits !== '0') {
      violations.push(`${table.schemaname}.${table.tablename} retained human PII in ${result.rows[0]?.hits ?? 'unknown'} row(s)`);
    }
  }
  return violations;
}

async function redisValues(pattern: string): Promise<Array<{ key: string; value: string }>> {
  const entries: Array<{ key: string; value: string }> = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      const type = await redis.type(key);
      let value = '';
      if (type === 'string') value = await redis.get(key) ?? '';
      else if (type === 'hash') value = JSON.stringify(await redis.hgetall(key));
      else if (type === 'list') value = JSON.stringify(await redis.lrange(key, 0, -1));
      else if (type === 'set') value = JSON.stringify(await redis.smembers(key));
      else if (type === 'zset') value = JSON.stringify(await redis.zrange(key, 0, -1, 'WITHSCORES'));
      entries.push({ key, value });
    }
  } while (cursor !== '0');
  return entries;
}

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

async function listObjectNames(prefix: string): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    const names: string[] = [];
    const listing = minio.listObjectsV2(DOCUMENT_BUCKET, prefix, true);
    listing.on('data', (item) => { if (item.name) names.push(item.name); });
    listing.on('error', reject);
    listing.on('end', () => resolve(names));
  });
}

async function collectExternalStoreViolations(fixture: BenchmarkFixture, subject: SubjectFixture): Promise<string[]> {
  const violations: string[] = [];
  const cache = await redisValues(`merchant:${fixture.merchantId}:*`);
  for (const entry of cache) {
    const hits = needleHits(`${entry.key}\n${entry.value}`, subject);
    if (hits.length > 0) violations.push(`Redis ${entry.key} retained ${hits.join(', ')}`);
  }
  const exists = await search.exists({ index: CUSTOMER_INDEX, id: `${fixture.merchantId}:${subject.customerId}` });
  if (exists.body) violations.push('OpenSearch retained the subject document');
  const result = await search.search({ index: CUSTOMER_INDEX, body: { size: 10, query: { query_string: {
    query: needles(subject).map((value) => `"${value.replaceAll('"', '\\"')}"`).join(' OR '),
  } } } });
  const hits = result.body.hits.total;
  const total = typeof hits === 'number' ? hits : hits?.value ?? 0;
  if (total !== 0) violations.push(`OpenSearch retained PII tokens in ${total} document(s)`);
  for (const objectName of await listObjectNames(`${fixture.merchantId}/`)) {
    const object = await minio.getObject(DOCUMENT_BUCKET, objectName);
    const hits = needleHits(`${objectName}\n${await streamText(object)}`, subject);
    if (hits.length > 0) violations.push(`MinIO ${objectName} retained ${hits.join(', ')}`);
  }
  for (const needle of [subject.email, subject.canary]) {
    const response = await fetch(`${settings.mailpit}/api/v1/search?query=${encodeURIComponent(needle)}`);
    if (!response.ok) throw new Error(`Mailpit search failed: ${response.status}`);
    const body = await response.json() as { messages_count?: number; messages?: unknown[] };
    // Mailpit's `total` is the total mailbox size, not the number matching
    // the query. Only `messages_count` represents a scoped PII hit.
    const total = body.messages_count ?? body.messages?.length ?? 0;
    if (total > 0) violations.push(`Mailpit retained ${needle} in ${total} provider message(s)`);
  }
  return violations;
}

export async function collectErasureViolations(fixture: BenchmarkFixture, subject: SubjectFixture): Promise<string[]> {
  return [...await collectPostgresViolations(fixture, subject),
    ...await collectExternalStoreViolations(fixture, subject)];
}

export function assertNoErasureViolations(violations: string[], phase = 'erasure verification'): void {
  assert(violations.length === 0,
    `${phase} found ${violations.length} violation(s):\n- ${violations.join('\n- ')}`);
}

export async function verifyErasedEverywhere(fixture: BenchmarkFixture, subject: SubjectFixture): Promise<void> {
  assertNoErasureViolations(await collectErasureViolations(fixture, subject));
}

export async function verifyFinancialRetention(fixture: BenchmarkFixture): Promise<void> {
  const financial = await pool.query<{ amount: string; currency: string; status: string; postings: string; signed_balance: string }>(
    `SELECT p.amount::text,p.currency,p.status,
       (SELECT count(*)::text FROM payments.ledger_entries e JOIN payments.ledger_postings lp ON lp.entry_id=e.id WHERE e.reference_id=p.id) postings,
       (SELECT COALESCE(sum(CASE WHEN lp.direction='debit' THEN lp.amount ELSE -lp.amount END),0)::text
        FROM payments.ledger_entries e JOIN payments.ledger_postings lp ON lp.entry_id=e.id WHERE e.reference_id=p.id) signed_balance
     FROM payments.payment_intents p WHERE p.id=$1`, [fixture.normal.paymentId],
  );
  const row = financial.rows[0];
  assert(row !== undefined, 'financial payment record was deleted');
  assert(row.amount === fixture.normalFinancial.amount && row.currency === fixture.normalFinancial.currency &&
    row.status === fixture.normalFinancial.status, 'immutable payment facts changed');
  assert(row.postings === fixture.normalFinancial.postings && row.signed_balance === fixture.normalFinancial.signedBalance,
    'ledger postings were deleted or unbalanced');
  const invoice = await pool.query<{
    subtotal: string; tax: string; total: string; quantity: string; unit_amount: string; line_total: string;
  }>(
    `SELECT i.subtotal::text,i.tax::text,i.total::text,l.quantity::text,l.unit_amount::text,l.total::text line_total
       FROM payments.invoices i JOIN payments.invoice_lines l ON l.invoice_id=i.id WHERE i.id=$1 ORDER BY l.id LIMIT 1`,
    [fixture.normal.invoiceId],
  );
  const invoiceRow = invoice.rows[0];
  assert(invoiceRow !== undefined, 'legally retained invoice or invoice line was deleted');
  assert(invoiceRow.subtotal === fixture.normalFinancial.invoiceSubtotal &&
    invoiceRow.tax === fixture.normalFinancial.invoiceTax && invoiceRow.total === fixture.normalFinancial.invoiceTotal &&
    invoiceRow.quantity === fixture.normalFinancial.invoiceLineQuantity &&
    invoiceRow.unit_amount === fixture.normalFinancial.invoiceLineUnitAmount &&
    invoiceRow.line_total === fixture.normalFinancial.invoiceLineTotal,
  'retained invoice financial values changed');
}

export async function verifySurvivorUntouched(fixture: BenchmarkFixture): Promise<void> {
  const result = await pool.query<{ email: string; name: string; phone: string; external_reference: string }>(
    `SELECT email,name,phone,external_reference FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
    [fixture.merchantId, fixture.survivor.customerId],
  );
  const row = result.rows[0];
  assert(row?.email === fixture.survivor.email && row.name === fixture.survivor.name &&
    row.phone === fixture.survivor.phone && row.external_reference === fixture.survivor.externalReference,
  'unrelated customer was changed');
  const participant = await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM customers.support_participants WHERE ticket_id=$1 AND customer_id=$2`,
    [fixture.normal.ticketId, fixture.survivor.customerId]);
  assert(participant.rows[0]?.count === '1', 'shared-ticket survivor participation was deleted');
  const message = await pool.query<{ body: string }>(
    `SELECT body FROM customers.support_messages WHERE ticket_id=$1 AND author_type='customer' AND author_id=$2`,
    [fixture.normal.ticketId, fixture.survivor.customerId],
  );
  assert(message.rows[0]?.body === fixture.survivor.messageBody,
    'shared-ticket survivor message was changed');
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

/** Confirms that erasing one customer does not revoke or alter the merchant's API credential. */
export async function verifyMerchantCredentialsPreserved(fixture: BenchmarkFixture): Promise<void> {
  const snapshot = fixture.merchantApiKey;
  const result = await pool.query<{ merchant_id: string; key_hash: string; label: string; scopes: string[]; revoked_at: string | null }>(
    `SELECT merchant_id,key_hash,label,scopes,revoked_at FROM platform.api_keys WHERE key_hash=$1`, [snapshot.keyHash],
  );
  assert(result.rowCount === 1, 'merchant API key was deleted');
  assertCredentialMatches(result.rows[0]!, snapshot);

  await api(fixture.merchantKey, `/v1/customers/${fixture.survivor.customerId}`, { expected: 200 });

  const afterAuthentication = await pool.query<{ merchant_id: string; key_hash: string; label: string; scopes: string[]; revoked_at: string | null }>(
    `SELECT merchant_id,key_hash,label,scopes,revoked_at FROM platform.api_keys WHERE key_hash=$1`, [snapshot.keyHash],
  );
  assert(afterAuthentication.rowCount === 1, 'merchant API key disappeared after authentication');
  assertCredentialMatches(afterAuthentication.rows[0]!, snapshot);
}

function assertCredentialMatches(row: { merchant_id: string; key_hash: string; label: string; scopes: string[]; revoked_at: string | null },
                                 snapshot: MerchantApiKeySnapshot): void {
  assert(row.merchant_id === snapshot.merchantId, 'merchant API key changed owner');
  assert(row.key_hash === snapshot.keyHash, 'merchant API key hash changed');
  assert(row.label === snapshot.label, 'merchant API key label changed');
  assert(sameScopes([...row.scopes].sort(), snapshot.scopes), 'merchant API key scopes changed');
  assert(row.revoked_at === snapshot.revokedAt, 'merchant API key revocation state changed');
}

export async function releaseDelayedWork(fixture: BenchmarkFixture): Promise<void> {
  await pool.query(`UPDATE operations.provider_webhooks SET next_attempt_at=now() WHERE id=$1`, [fixture.delayedWebhookId]);
  await pool.query(`UPDATE operations.jobs SET available_at=now() WHERE id=$1`, [fixture.delayedJobId]);
  await pool.query(`UPDATE operations.email_deliveries SET available_at=now() WHERE id=$1`, [fixture.delayedEmailDeliveryId]);
  await poll(async () => (await pool.query<{ status: string }>(
    `SELECT status FROM operations.provider_webhooks WHERE id=$1`, [fixture.delayedWebhookId])).rows[0]?.status,
  (status) => status === 'processed', 'delayed webhook');
  await poll(async () => (await pool.query<{ status: string }>(
    `SELECT status FROM payments.payment_intents WHERE id=$1`, [fixture.delayed.paymentId])).rows[0]?.status,
  (status) => status === 'succeeded', 'delayed payment success');
  await poll(async () => Number((await pool.query<{ pending: string }>(
    `SELECT count(*)::text pending FROM operations.jobs WHERE payload->>'paymentId'=$1 AND status<>'completed'`,
    [fixture.delayed.paymentId])).rows[0]?.pending ?? '-1'), (count) => count === 0, 'post-erasure document jobs', 160);
  const journal = await pool.query<{ captures: string; postings: string; signed_balance: string }>(
    `SELECT (SELECT count(*)::text FROM payments.captures WHERE payment_intent_id=$1) captures,
       (SELECT count(*)::text FROM payments.ledger_entries e JOIN payments.ledger_postings p ON p.entry_id=e.id WHERE e.reference_id=$1) postings,
       (SELECT COALESCE(sum(CASE WHEN p.direction='debit' THEN p.amount ELSE -p.amount END),0)::text
        FROM payments.ledger_entries e JOIN payments.ledger_postings p ON p.entry_id=e.id WHERE e.reference_id=$1) signed_balance`,
    [fixture.delayed.paymentId],
  );
  assert(journal.rows[0]?.captures === '1' && journal.rows[0]?.postings === '2' && journal.rows[0]?.signed_balance === '0',
    'delayed financial work was not preserved exactly once and balanced');
}

export async function replayHistoricalPiiEvent(fixture: BenchmarkFixture): Promise<void> {
  const producer = kafka.producer();
  const eventId = randomUUID();
  await producer.connect();
  try {
    await producer.send({ topic: 'payflow.domain-events.v1', messages: [{ key: fixture.delayed.customerId, value: JSON.stringify({
      eventId, eventType: 'payment.succeeded.v1', eventVersion: 1, occurredAt: new Date().toISOString(),
      aggregateType: 'payment_intent', aggregateId: fixture.delayed.paymentId, merchantId: fixture.merchantId,
      correlationId: randomUUID(), payload: { customerId: fixture.delayed.customerId,
        customerEmail: fixture.delayed.email, name: fixture.delayed.name, canary: fixture.delayed.canary,
        paymentId: fixture.delayed.paymentId, amount: 9100, currency: 'USD' },
    }) }] });
  } finally {
    await producer.disconnect();
  }
  await poll(async () => Number((await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM operations.inbox_events WHERE event_id=$1 AND consumer IN ('projection-worker','notification-worker') AND status='processed'`,
    [eventId])).rows[0]?.count ?? '0'), (count) => count === 2, 'historical event consumers', 160);
}
