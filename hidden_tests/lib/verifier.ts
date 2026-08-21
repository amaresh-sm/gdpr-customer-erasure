import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DOCUMENT_BUCKET, CUSTOMER_INDEX, kafka, minio, pool, redis, search, settings } from './clients.js';
import { api, poll } from './http.js';
import type { BenchmarkFixture, SubjectFixture } from './fixture.js';

interface ErasureResponse {
  id: string;
  customerId: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
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
    const body = await response.json() as { total?: number; messages?: unknown[] };
    const total = body.total ?? body.messages?.length ?? 0;
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
  const invoice = await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM payments.invoices WHERE id=$1`, [fixture.normal.invoiceId]);
  assert(invoice.rows[0]?.count === '1', 'legally retained invoice was deleted');
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
