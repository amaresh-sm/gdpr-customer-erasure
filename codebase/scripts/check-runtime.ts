import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { config } from '../packages/config/src/index.js';
import { pool } from '../packages/database/src/pool.js';
import { CUSTOMER_INDEX, searchClient } from '../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../packages/storage/src/minio.js';

const database = await pool.query<{
  customers: string; payments: string; published: string; unfinished_webhooks: string; dead_letters: string;
  unbalanced_entries: string; missing_captures: string; unfinished_jobs: string; missing_receipts: string; manifests: string;
  unfinished_outbox: string; unfinished_emails: string; delivered_emails: string; unfinished_notifications: string;
  undelivered_provider_callbacks: string; mismatched_reconciliation_runs: string;
}>(`
  SELECT
    (SELECT count(*) FROM customers.customers)::text customers,
    (SELECT count(*) FROM payments.payment_intents)::text payments,
    (SELECT count(*) FROM operations.outbox_events WHERE status='published')::text published,
    (SELECT count(*) FROM operations.outbox_events WHERE status<>'published')::text unfinished_outbox,
    (SELECT count(*) FROM operations.provider_webhooks WHERE status<>'processed')::text unfinished_webhooks,
    (SELECT count(*) FROM operations.dead_letters)::text dead_letters,
    (SELECT count(*) FROM operations.jobs WHERE status<>'completed')::text unfinished_jobs,
    (SELECT count(*) FROM operations.email_deliveries WHERE status<>'delivered')::text unfinished_emails,
    (SELECT count(*) FROM operations.email_deliveries WHERE status='delivered')::text delivered_emails,
    (SELECT count(*) FROM operations.notifications WHERE status<>'delivered')::text unfinished_notifications,
    ((SELECT count(*) FROM provider_sandbox.payment_intents WHERE webhook_delivered_at IS NULL) +
     (SELECT count(*) FROM provider_sandbox.refunds WHERE webhook_url IS NOT NULL AND webhook_delivered_at IS NULL))::text
      undelivered_provider_callbacks,
    (SELECT count(*) FROM payments.reconciliation_runs WHERE status<>'matched')::text mismatched_reconciliation_runs,
    (SELECT count(*) FROM (
      SELECT e.id FROM payments.ledger_entries e JOIN payments.ledger_postings p ON p.entry_id=e.id
      GROUP BY e.id HAVING sum(CASE WHEN p.direction='debit' THEN p.amount ELSE -p.amount END)<>0
    ) invalid)::text unbalanced_entries,
    (SELECT count(*) FROM payments.payment_intents p WHERE p.status IN ('succeeded','partially_refunded','refunded')
      AND NOT EXISTS(SELECT 1 FROM payments.captures c WHERE c.payment_intent_id=p.id AND c.status='succeeded'))::text missing_captures,
    (SELECT count(*) FROM payments.payment_intents p WHERE p.status IN ('succeeded','partially_refunded','refunded')
      AND NOT EXISTS(SELECT 1 FROM operations.document_manifests d WHERE d.document_type='receipt'
      AND d.metadata->>'paymentId'=p.id::text))::text missing_receipts,
    (SELECT count(*) FROM operations.document_manifests)::text manifests
`);
const state = database.rows[0]!;
assert.ok(Number(state.customers) >= 3, 'expected realistic customer data');
assert.ok(Number(state.payments) >= 3, 'expected realistic payment data');
assert.ok(Number(state.published) >= 1, 'outbox did not publish');
assert.equal(Number(state.unfinished_outbox), 0, 'outbox events are unfinished');
assert.equal(Number(state.unfinished_webhooks), 0, 'provider webhooks are unfinished');
assert.equal(Number(state.dead_letters), 0, 'dead letters exist');
assert.equal(Number(state.unfinished_jobs), 0, 'background jobs are unfinished');
assert.equal(Number(state.unfinished_emails), 0, 'email deliveries are unfinished');
assert.equal(Number(state.unfinished_notifications), 0, 'notification records are unfinished');
assert.equal(Number(state.undelivered_provider_callbacks), 0, 'provider callbacks are unfinished');
assert.equal(Number(state.mismatched_reconciliation_runs), 0, 'reconciliation contains mismatched runs');
assert.equal(Number(state.unbalanced_entries), 0, 'ledger contains unbalanced entries');
assert.equal(Number(state.missing_captures), 0, 'successful payment is missing a capture');
assert.equal(Number(state.missing_receipts), 0, 'successful payment is missing a receipt');

const redis = new Redis(config().REDIS_URL);
let cursor = '0';
let projectedCustomers = 0;
do {
  const [next, keys] = await redis.scan(cursor, 'MATCH', 'merchant:*:customer:*', 'COUNT', 100);
  cursor = next;
  projectedCustomers += keys.filter((key) => !key.endsWith(':activity')).length;
} while (cursor !== '0');
assert.ok(projectedCustomers >= Number(state.customers), 'Redis customer projections are incomplete');

const search = await searchClient.count({ index: CUSTOMER_INDEX });
assert.ok(search.body.count >= Number(state.customers), 'OpenSearch customer projections are incomplete');

let storedObjects = 0;
await new Promise<void>((resolve, reject) => {
  const stream = objectStore.listObjectsV2(DOCUMENT_BUCKET, '', true);
  stream.on('data', () => { storedObjects += 1; });
  stream.on('error', reject);
  stream.on('end', resolve);
});
assert.equal(storedObjects, Number(state.manifests), 'MinIO objects and document manifests differ');

const mailpitResponse = await fetch(`${config().MAILPIT_API_URL}/api/v1/messages`);
assert.ok(mailpitResponse.ok, `Mailpit message listing failed (${mailpitResponse.status})`);
const mailpit = await mailpitResponse.json() as { total?: number; messages?: unknown[] };
const capturedEmails = mailpit.total ?? mailpit.messages?.length ?? 0;
assert.ok(capturedEmails >= Number(state.delivered_emails), 'Mailpit has fewer messages than delivered email records');

console.log(JSON.stringify({
  status: 'verified', database: state, redis: { projectedCustomers },
  opensearch: { customerDocuments: search.body.count }, minio: { storedObjects }, mailpit: { capturedEmails }
}, null, 2));
await redis.quit();
await pool.end();
