import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { config } from '../../../packages/config/src/index.js';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';

/**
 * A stable, PII-free classification of an erasure failure. Stored as `last_error` on the
 * request row, so retries and status checks never leak the customer data being removed.
 */
export class ErasureStepError extends Error {
  constructor(readonly code: string, cause?: unknown) {
    super(code, { cause });
  }
}

interface AnonymizedIdentity {
  email: string;
  name: string;
  externalReference: string;
}

interface DocumentManifest {
  object_key: string;
  document_type: string;
}

function anonymizedIdentity(customerId: string): AnonymizedIdentity {
  return {
    email: `erased-${customerId}@erased.payflow.invalid`,
    name: 'Erased Customer',
    externalReference: `erased-${customerId}`,
  };
}

async function redactCustomerRecord(
  client: pg.PoolClient, merchantId: string, customerId: string, identity: AnonymizedIdentity,
): Promise<void> {
  const result = await client.query(
    `UPDATE customers.customers
     SET email=$3,name=$4,phone=NULL,external_reference=$5,metadata='{}',status='erased',
         version=version+1,updated_at=now()
     WHERE merchant_id=$1 AND id=$2`,
    [merchantId, customerId, identity.email, identity.name, identity.externalReference],
  );
  if (!result.rowCount) throw new ErasureStepError('customer_record_missing');
}

async function deletePersonalRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
  await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
}

async function redactSupportRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
  await client.query(
    `UPDATE customers.support_messages SET body='[redacted]'
     WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE customers.support_tickets t SET subject='[redacted]'
     WHERE merchant_id=$1 AND EXISTS(
       SELECT 1 FROM customers.support_participants sp WHERE sp.ticket_id=t.id AND sp.customer_id=$2
     )`,
    [merchantId, customerId],
  );
}

async function redactPaymentRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
  const snapshot = { id: customerId, status: 'erased' };
  await client.query(
    `UPDATE payments.payment_intents SET customer_snapshot=$3::jsonb,updated_at=now()
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId, snapshot],
  );
  await client.query(
    `UPDATE payments.refunds r SET customer_email=NULL
     FROM payments.payment_intents p
     WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE payments.disputes d SET evidence='{}'::jsonb
     FROM payments.payment_intents p
     WHERE d.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE payments.invoices SET billing_snapshot=$3::jsonb
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId, snapshot],
  );
}

async function redactProviderSandboxCustomer(
  client: pg.PoolClient, merchantId: string, customerId: string, identity: AnonymizedIdentity,
): Promise<void> {
  await client.query(
    `UPDATE provider_sandbox.customers SET email=$3,name=$4,external_reference=$5,updated_at=now()
     WHERE merchant_id=$1 AND payflow_customer_id=$2`,
    [merchantId, customerId, identity.email, identity.name, identity.externalReference],
  );
}

async function redactNotificationRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
  await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(
    `UPDATE operations.notifications SET destination='erased',payload='{}'::jsonb,updated_at=now()
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE operations.email_deliveries
     SET destination='erased',subject='[redacted]',text_body='[redacted]',html_body='[redacted]'
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  // Event payloads vary by event type and may embed arbitrary customer fields (name, phone,
  // address lines, contact values); replace the whole snapshot rather than trying to enumerate keys.
  await client.query(
    `UPDATE operations.analytics_events SET email=NULL,properties='{"redacted":true}'::jsonb
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
}

async function fetchDocumentManifests(merchantId: string, customerId: string): Promise<DocumentManifest[]> {
  const result = await pool.query<DocumentManifest>(
    `SELECT object_key,document_type FROM operations.document_manifests
     WHERE merchant_id=$1 AND customer_id=$2 AND document_type IN ('receipt','invoice')`,
    [merchantId, customerId],
  );
  return result.rows;
}

async function readObject(objectKey: string): Promise<string> {
  const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Rewrites stored receipt/invoice documents in place so the object no longer identifies the customer. */
async function redactStoredDocuments(manifests: DocumentManifest[], customerId: string): Promise<void> {
  if (!manifests.length) return;
  try {
    await ensureBucket();
    for (const manifest of manifests) {
      const parsed = JSON.parse(await readObject(manifest.object_key)) as Record<string, unknown>;
      parsed.customer = { id: customerId, status: 'erased' };
      const body = JSON.stringify(parsed);
      await objectStore.putObject(DOCUMENT_BUCKET, manifest.object_key, body, Buffer.byteLength(body), { 'Content-Type': 'application/json' });
      const checksum = createHash('sha256').update(body).digest('hex');
      await pool.query(`UPDATE operations.document_manifests SET checksum=$2 WHERE object_key=$1`, [manifest.object_key, checksum]);
    }
  } catch (error) {
    throw new ErasureStepError('document_storage_error', error);
  }
}

let cachedRedis: Redis | undefined;
function redisClient(): Redis {
  cachedRedis ??= new Redis(config().REDIS_URL);
  return cachedRedis;
}

/** Overwrites the active customer projection cache instead of deleting it, so cached-record counts stay stable. */
async function redactCache(merchantId: string, customerId: string, identity: AnonymizedIdentity): Promise<void> {
  try {
    const redis = redisClient();
    const cacheKey = `merchant:${merchantId}:customer:${customerId}`;
    const document = { merchantId, customerId, email: identity.email, name: identity.name, phone: null, updatedAt: new Date().toISOString() };
    await redis.set(cacheKey, JSON.stringify(document), 'EX', 3600);
    await redis.del(`${cacheKey}:activity`);
  } catch (error) {
    throw new ErasureStepError('cache_error', error);
  }
}

async function redactSearchIndex(merchantId: string, customerId: string, identity: AnonymizedIdentity): Promise<void> {
  try {
    await searchClient.index({
      index: CUSTOMER_INDEX,
      id: `${merchantId}:${customerId}`,
      body: { merchantId, customerId, email: identity.email, name: identity.name, phone: null, updatedAt: new Date().toISOString() },
      refresh: false,
    });
  } catch (error) {
    throw new ErasureStepError('search_index_error', error);
  }
}

/**
 * Erases a customer's personal data from every PayFlow-controlled system while preserving the
 * financial meaning of retained records. Every step is idempotent so a crash or retry safely
 * converges on the same fully-erased result without restoring personal data.
 */
export async function eraseCustomerData(merchantId: string, customerId: string): Promise<void> {
  const identity = anonymizedIdentity(customerId);
  const manifests = await fetchDocumentManifests(merchantId, customerId);

  try {
    await transaction(async (client) => {
      await redactCustomerRecord(client, merchantId, customerId, identity);
      await deletePersonalRecords(client, merchantId, customerId);
      await redactSupportRecords(client, merchantId, customerId);
      await redactPaymentRecords(client, merchantId, customerId);
      await redactProviderSandboxCustomer(client, merchantId, customerId, identity);
      await redactNotificationRecords(client, merchantId, customerId);
    });
  } catch (error) {
    if (error instanceof ErasureStepError) throw error;
    throw new ErasureStepError('database_error', error);
  }

  await redactStoredDocuments(manifests, customerId);
  await redactCache(merchantId, customerId, identity);
  await redactSearchIndex(merchantId, customerId, identity);
}
