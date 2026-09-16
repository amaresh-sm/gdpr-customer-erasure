import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { advisoryLock, pool, transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import {
  erasedCustomerProjection,
  erasureLockKey,
  ErasureStepError,
  importReferencesCustomer,
  scrubStoredDocument,
  type ErasureIdentifiers,
} from '../../../packages/privacy/src/erasure.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';
import type { ErasureRequestRow } from './repository.js';

export { ERASURE_ERROR_CODES, ErasureStepError, type ErasureErrorCode } from '../../../packages/privacy/src/erasure.js';

/** Reads the customer's current identifiers before the database scrub removes them. */
async function captureIdentifiers(request: ErasureRequestRow): Promise<ErasureIdentifiers> {
  const result = await pool.query<{ email: string; external_reference: string }>(
    `SELECT email,external_reference FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
    [request.merchant_id, request.customer_id],
  );
  return {
    customerId: request.customer_id,
    email: result.rows[0]?.email ?? null,
    externalReference: result.rows[0]?.external_reference ?? null,
  };
}

/**
 * Removes the customer's personal data from the primary database. Retained financial records
 * keep their amounts and references but point at the request's anonymous replacement id, so
 * they stay financially meaningful without identifying the deleted customer. Locking the
 * customer, its payments, and its refunds serializes this transaction with in-flight provider
 * callbacks and API writes: work that commits afterwards reads already scrubbed data, and
 * anything committed before is scrubbed here. Every statement is idempotent.
 */
async function scrubDatabase(request: ErasureRequestRow): Promise<void> {
  const merchantId = request.merchant_id;
  const customerId = request.customer_id;
  const replacementId = request.replacement_id;
  await transaction(async (client) => {
    const customer = await client.query<{ email: string }>(
      `SELECT email FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    const email = customer.rows[0]?.email ?? null;
    await advisoryLock(client, erasureLockKey(merchantId, customerId));
    await client.query(
      `SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    await client.query(
      `SELECT r.id FROM payments.refunds r JOIN payments.payment_intents p ON p.id=r.payment_intent_id
       WHERE p.merchant_id=$1 AND p.customer_id=$2 FOR UPDATE OF r`,
      [merchantId, customerId],
    );

    const statements: Array<[string, unknown[]]> = [
      [`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]],
      [`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]],
      [`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]],
      [`DELETE FROM operations.analytics_events
        WHERE merchant_id=$1 AND (customer_id=$2 OR ($3::text IS NOT NULL AND email=$3))`, [merchantId, customerId, email]],
      [`DELETE FROM customers.support_messages
        WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`, [merchantId, customerId]],
      [`DELETE FROM customers.support_participants WHERE customer_id=$2
        AND ticket_id IN (SELECT id FROM customers.support_tickets WHERE merchant_id=$1)`, [merchantId, customerId]],
      [`DELETE FROM customers.support_tickets t WHERE t.merchant_id=$1
        AND NOT EXISTS(SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM customers.support_messages m WHERE m.ticket_id=t.id)`, [merchantId]],
      [`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]],
      [`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]],
      [`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]],
      [`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]],
      [`UPDATE payments.payment_attempts a
        SET request_payload=jsonb_set(a.request_payload,'{customerId}',to_jsonb($3::uuid::text),false) - 'description'
        FROM payments.payment_intents p
        WHERE a.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`, [merchantId, customerId, replacementId]],
      [`UPDATE payments.refunds r SET customer_email=NULL FROM payments.payment_intents p
        WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`, [merchantId, customerId]],
      [`UPDATE payments.disputes d SET evidence='{}'::jsonb FROM payments.payment_intents p
        WHERE d.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`, [merchantId, customerId]],
      [`UPDATE payments.payment_intents
        SET customer_id=$3,customer_snapshot=jsonb_build_object('id',$3::uuid::text,'erased',true),description=NULL
        WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId, replacementId]],
      [`UPDATE payments.invoices
        SET customer_id=$3,billing_snapshot=jsonb_build_object('erased',true)
        WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId, replacementId]],
      [`UPDATE operations.document_manifests SET customer_id=$3
        WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId, replacementId]],
      [`UPDATE provider_sandbox.customers
        SET payflow_customer_id=$3,email='erased-'||id||'@erased.invalid',name='Erased Customer',
            external_reference='erased-'||$3::uuid::text,updated_at=now()
        WHERE merchant_id=$1 AND payflow_customer_id=$2`, [merchantId, customerId, replacementId]],
      [`UPDATE operations.outbox_events SET payload=CASE
         WHEN aggregate_type='customer' AND aggregate_id=$2
           THEN jsonb_build_object('customerId',$3::uuid::text,'erased',true)
         ELSE jsonb_set(payload,'{customerId}',to_jsonb($3::uuid::text),false)
              - 'customerEmail' - 'email' - 'customerSnapshot' - 'customer' - 'billingName'
              - 'destination' - 'subject' - 'body' - 'name' - 'phone' - 'externalReference' - 'metadata'
              - 'value' - 'line1' - 'line2' - 'city' - 'region' - 'postalCode' - 'country' END
        WHERE merchant_id=$1 AND event_type<>'customer.erased.v1'
          AND ((aggregate_type='customer' AND aggregate_id=$2) OR payload->>'customerId'=$2::uuid::text)`,
       [merchantId, customerId, replacementId]],
      [`UPDATE operations.jobs
        SET payload=jsonb_set(payload,'{customerId}',to_jsonb($3::uuid::text),false)
            || jsonb_build_object('customerSnapshot',jsonb_build_object('erased',true))
        WHERE merchant_id=$1 AND payload->>'customerId'=$2::uuid::text`, [merchantId, customerId, replacementId]],
      [`UPDATE operations.dead_letters
        SET payload=jsonb_set(payload,'{customerId}',to_jsonb($2::uuid::text),false)
            - 'customerEmail' - 'email' - 'customerSnapshot' - 'customer' - 'billingName'
            - 'destination' - 'subject' - 'body' - 'text_body' - 'html_body'
        WHERE payload::text LIKE '%'||$1::text||'%'`, [customerId, replacementId]],
      [`UPDATE platform.audit_logs SET metadata='{"erased":true}'::jsonb
        WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2::text`, [merchantId, customerId]],
      [`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]],
      [`INSERT INTO customers.customers(id,merchant_id,external_reference,email,name,phone,status,metadata)
        VALUES($2,$1,'erased-'||$2::uuid::text,'erased-'||$2::uuid::text||'@erased.invalid','Erased Customer',NULL,'erased','{}')
        ON CONFLICT(id) DO NOTHING`, [merchantId, replacementId]],
    ];
    for (const [sql, params] of statements) await client.query(sql, params);

    await addOutboxEvent(client, {
      eventType: EVENT_TYPES.CUSTOMER_ERASED, aggregateType: 'customer', aggregateId: customerId,
      merchantId, correlationId: uuid(), payload: { customerId },
    });
    await client.query(
      `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
       VALUES($1,'system','erasure_request',$2,'customer.erasure.scrubbed','{}',$3)`,
      [merchantId, request.id, uuid()],
    );
  });
}

async function getObjectText(objectKey: string): Promise<string | null> {
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'NoSuchKey' || code === 'NotFound') return null;
    throw error;
  }
}

async function listObjectKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = objectStore.listObjectsV2(DOCUMENT_BUCKET, prefix, true);
    stream.on('data', (item: { name?: string }) => { if (item.name) keys.push(item.name); });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return keys;
}

/**
 * Sweeps the merchant's stored documents: import artifacts that reference the customer are
 * deleted, while retained financial documents (receipts, invoices) are rewritten so they keep
 * their financial meaning without identifying the customer. Idempotent and safe to retry.
 */
async function scrubObjectStore(request: ErasureRequestRow, identifiers: ErasureIdentifiers): Promise<void> {
  await ensureBucket();
  const prefix = `${request.merchant_id}/`;
  for (const objectKey of await listObjectKeys(prefix)) {
    const body = await getObjectText(objectKey);
    if (body === null || !importReferencesCustomer(body, identifiers)) continue;
    if (objectKey.startsWith(`${prefix}imports/`)) {
      await objectStore.removeObject(DOCUMENT_BUCKET, objectKey);
      await pool.query(`DELETE FROM operations.document_manifests WHERE object_key=$1`, [objectKey]);
      await pool.query(`DELETE FROM customers.customer_imports WHERE object_key=$1`, [objectKey]);
      continue;
    }
    const scrubbed = scrubStoredDocument(body);
    if (scrubbed === null) continue;
    await objectStore.putObject(DOCUMENT_BUCKET, objectKey, scrubbed, Buffer.byteLength(scrubbed), {
      'Content-Type': 'application/json',
    });
    await pool.query(
      `UPDATE operations.document_manifests SET checksum=$2 WHERE object_key=$1`,
      [objectKey, createHash('sha256').update(scrubbed).digest('hex')],
    );
  }
}

async function scrubCache(request: ErasureRequestRow): Promise<void> {
  const redis = new Redis(config().REDIS_URL);
  try {
    const key = `merchant:${request.merchant_id}:customer:${request.customer_id}`;
    await redis.set(key, JSON.stringify(erasedCustomerProjection(request.merchant_id, request.customer_id)), 'EX', 3600);
    await redis.del(`${key}:activity`);
  } finally {
    await redis.quit();
  }
}

async function scrubSearchIndex(request: ErasureRequestRow): Promise<void> {
  await searchClient.index({
    index: CUSTOMER_INDEX,
    id: `${request.merchant_id}:${request.customer_id}`,
    body: erasedCustomerProjection(request.merchant_id, request.customer_id),
    refresh: true,
  });
}

/** Runs one erasure attempt. Steps are idempotent, so retries preserve finished work. */
export async function executeErasure(request: ErasureRequestRow): Promise<void> {
  const identifiers = await captureIdentifiers(request);
  try {
    await scrubDatabase(request);
  } catch (error) {
    throw new ErasureStepError('database_cleanup_failed', error);
  }
  try {
    await scrubObjectStore(request, identifiers);
  } catch (error) {
    throw new ErasureStepError('object_store_cleanup_failed', error);
  }
  try {
    await scrubCache(request);
  } catch (error) {
    throw new ErasureStepError('cache_cleanup_failed', error);
  }
  try {
    await scrubSearchIndex(request);
  } catch (error) {
    throw new ErasureStepError('search_cleanup_failed', error);
  }
}
