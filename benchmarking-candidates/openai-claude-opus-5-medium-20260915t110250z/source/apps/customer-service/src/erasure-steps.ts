import type pg from 'pg';
import { Redis } from 'ioredis';
import { config } from '../../../packages/config/src/index.js';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import {
  documentReferencesCustomer,
  redactDocument,
} from '../../../packages/privacy/src/redaction.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';
import type { ErasureSubject } from './erasure-repository.js';

export interface ErasureTarget {
  requestId: string;
  merchantId: string;
  customerId: string;
  subject: ErasureSubject;
}

export interface ErasureStep {
  name: string;
  run: (target: ErasureTarget) => Promise<void>;
}

/**
 * Records the tombstone that makes the deletion durable. This runs first so that every other
 * PayFlow component stops writing the customer's personal data before cleanup begins; without it a
 * concurrent request or a replayed event could recreate rows the later steps have already removed.
 */
async function writeTombstone(target: ErasureTarget): Promise<void> {
  await pool.query(
    `INSERT INTO privacy.erased_customers(merchant_id,customer_id,request_id)
     VALUES($1,$2,$3) ON CONFLICT(merchant_id,customer_id) DO NOTHING`,
    [target.merchantId, target.customerId, target.requestId],
  );
}

async function eraseSearchDocuments(target: ErasureTarget): Promise<void> {
  await searchClient.delete(
    { index: CUSTOMER_INDEX, id: `${target.merchantId}:${target.customerId}` },
    { ignore: [404] },
  );
  await searchClient.deleteByQuery({
    index: CUSTOMER_INDEX,
    body: { query: { bool: { filter: [
      { term: { merchantId: target.merchantId } },
      { term: { customerId: target.customerId } },
    ] } } },
    refresh: true,
    conflicts: 'proceed',
  }, { ignore: [404] });
}

async function eraseCache(target: ErasureTarget): Promise<void> {
  const redis = new Redis(config().REDIS_URL);
  try {
    const key = `merchant:${target.merchantId}:customer:${target.customerId}`;
    await redis.del(key, `${key}:activity`);
  } finally {
    await redis.quit();
  }
}

/**
 * Rewrites stored receipts, invoices, and import artifacts in place. The objects are financial
 * evidence that PayFlow retains, so each one keeps its key and manifest while losing the customer's
 * personal data; the recorded checksum is refreshed so the manifest still describes the object.
 */
async function eraseStoredObjects(target: ErasureTarget): Promise<void> {
  await ensureBucket();
  const manifests = await pool.query<{ object_key: string; customer_id: string | null }>(
    `SELECT object_key,customer_id FROM operations.document_manifests
     WHERE merchant_id=$1 AND (customer_id=$2 OR customer_id IS NULL)`,
    [target.merchantId, target.customerId],
  );
  for (const manifest of manifests.rows) {
    await redactStoredObject(manifest.object_key, target, manifest.customer_id !== null);
  }
}

async function redactStoredObject(
  objectKey: string,
  target: ErasureTarget,
  ownedByCustomer: boolean,
): Promise<void> {
  let original: string;
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    original = Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    // A manifest without its object cannot hold personal data; other steps stay unaffected.
    if ((error as { code?: string }).code === 'NoSuchKey') return;
    throw error;
  }
  if (!ownedByCustomer && !documentReferencesCustomer(original, target.customerId, target.subject.email)) return;

  const redacted = JSON.stringify(redactDocument(JSON.parse(original)));
  if (redacted === original) return;
  await objectStore.putObject(DOCUMENT_BUCKET, objectKey, redacted, Buffer.byteLength(redacted), {
    'Content-Type': 'application/json',
  });
  await pool.query(
    `UPDATE operations.document_manifests
     SET checksum=encode(digest($2,'sha256'),'hex'),metadata=privacy.redact_payload(metadata)
     WHERE object_key=$1`,
    [objectKey, redacted],
  );
}

/**
 * De-identifies the durable message plumbing. Envelopes stay so that in-flight and replayed work
 * still resolves, but they no longer carry the personal data a consumer could project back out.
 */
async function eraseMessaging(target: ErasureTarget): Promise<void> {
  const { merchantId, customerId, subject } = target;
  const email = subject.email;
  await transaction(async (client) => {
    await client.query(
      `UPDATE operations.outbox_events
       SET payload=privacy.redact_payload(payload)
       WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2::text
         OR ($3::text IS NOT NULL AND payload->>'customerEmail'=$3))`,
      [merchantId, customerId, email],
    );
    await client.query(
      `UPDATE operations.analytics_events
       SET email=NULL,anonymous_id=NULL,properties=privacy.redact_payload(properties)
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE platform.audit_logs SET metadata=privacy.redact_payload(metadata)
       WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2::text`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.dead_letters SET payload=privacy.redact_payload(payload)
       WHERE payload->>'customerId'=$1::text OR ($2::text IS NOT NULL AND payload->>'destination'=$2)`,
      [customerId, email],
    );
    await client.query(
      `UPDATE operations.jobs SET payload=privacy.redact_payload(payload)
       WHERE merchant_id=$1 AND payload->>'customerId'=$2::text`,
      [merchantId, customerId],
    );
  });
  if (email) await deleteMailpitMessagesForRecipient(email);
}

/**
 * Removes the customer's own records and de-identifies the financial records PayFlow retains. This
 * runs last because earlier steps need the customer's contact details to find data held elsewhere.
 */
async function eraseRecords(target: ErasureTarget): Promise<void> {
  await transaction(async (client) => {
    await retainFinancialRecords(client, target);
    await releaseSharedSupportRecords(client, target);
    await deletePersonalRecords(client, target);
  });
}

async function retainFinancialRecords(client: pg.PoolClient, target: ErasureTarget): Promise<void> {
  const { merchantId, customerId } = target;
  await client.query(
    `UPDATE payments.payment_intents
     SET customer_snapshot=privacy.redact_payload(customer_snapshot),updated_at=now()
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE payments.payment_attempts a
     SET request_payload=privacy.redact_payload(a.request_payload),
         response_payload=CASE WHEN a.response_payload IS NULL THEN NULL
           ELSE privacy.redact_payload(a.response_payload) END
     FROM payments.payment_intents p
     WHERE a.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE payments.refunds r SET customer_email=NULL
     FROM payments.payment_intents p
     WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE payments.disputes d SET evidence=privacy.redact_payload(d.evidence)
     FROM payments.payment_intents p
     WHERE d.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE payments.invoices SET billing_snapshot=privacy.redact_payload(billing_snapshot)
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  // The local provider profile is PayFlow-controlled, so it is de-identified rather than kept.
  await client.query(
    `UPDATE provider_sandbox.customers
     SET email=concat('erased+',payflow_customer_id::text,'@invalid.test'),name='erased customer',
         external_reference=concat('erased-',payflow_customer_id::text),updated_at=now()
     WHERE merchant_id=$1 AND payflow_customer_id=$2`,
    [merchantId, customerId],
  );
}

/** Leaves shared support threads usable for the participants who still need them. */
async function releaseSharedSupportRecords(client: pg.PoolClient, target: ErasureTarget): Promise<void> {
  const { merchantId, customerId } = target;
  await client.query(
    `DELETE FROM customers.support_messages
     WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `DELETE FROM customers.support_participants WHERE customer_id=$1`,
    [customerId],
  );
  await client.query(
    `DELETE FROM customers.support_messages m
     WHERE m.merchant_id=$1 AND NOT EXISTS(
       SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=m.ticket_id)`,
    [merchantId],
  );
  await client.query(
    `DELETE FROM customers.support_tickets t
     WHERE t.merchant_id=$1 AND NOT EXISTS(
       SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id)`,
    [merchantId],
  );
}

async function deletePersonalRecords(client: pg.PoolClient, target: ErasureTarget): Promise<void> {
  const { merchantId, customerId } = target;
  for (const statement of [
    `DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`,
    `DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`,
    `DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`,
    `DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`,
    `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
    `DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`,
    `DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`,
    `DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
  ]) {
    await client.query(statement, [merchantId, customerId]);
  }
}

/**
 * The cleanup steps in the order they must run. Each one is idempotent and is recorded on success,
 * so a request that fails or restarts resumes at the first unfinished step.
 */
export const ERASURE_STEPS: ErasureStep[] = [
  { name: 'tombstone', run: writeTombstone },
  { name: 'search', run: eraseSearchDocuments },
  { name: 'cache', run: eraseCache },
  { name: 'objects', run: eraseStoredObjects },
  { name: 'messaging', run: eraseMessaging },
  { name: 'records', run: eraseRecords },
];
