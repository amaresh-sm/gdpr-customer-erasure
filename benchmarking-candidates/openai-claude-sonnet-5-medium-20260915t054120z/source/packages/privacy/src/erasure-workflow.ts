import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { config } from '../../config/src/index.js';
import { EVENT_TYPES } from '../../contracts/src/events.js';
import { pool, transaction } from '../../database/src/pool.js';
import { addOutboxEvent } from '../../messaging/src/outbox.js';
import { deleteMailpitMessagesForRecipient } from '../../notifications/src/mailpit.js';
import { CUSTOMER_INDEX, searchClient } from '../../search/src/client.js';
import { DOCUMENT_BUCKET, getJsonObject, putJsonObject } from '../../storage/src/minio.js';
import { anonymizeCustomerSnapshot, anonymizeStoredDocument, redactedEmail, redactedExternalReference, REDACTED_NAME } from './anonymize.js';
import { ErasureStepError } from './errors.js';

const redis = new Redis(config().REDIS_URL);

async function step<T>(code: ConstructorParameters<typeof ErasureStepError>[0], operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ErasureStepError) throw error;
    throw new ErasureStepError(code, error);
  }
}

async function currentEmail(merchantId: string, customerId: string): Promise<string | undefined> {
  const result = await pool.query<{ email: string }>(
    `SELECT email FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId],
  );
  return result.rows[0]?.email;
}

/** Purges any captured provider emails still addressed to the customer. */
async function purgeMail(merchantId: string, customerId: string): Promise<void> {
  const email = await currentEmail(merchantId, customerId);
  if (!email) return;
  await step('mail_provider_unavailable', () => deleteMailpitMessagesForRecipient(email));
}

/** Rewrites stored receipt/invoice documents so they no longer identify the customer. */
async function redactStoredDocuments(merchantId: string, customerId: string): Promise<void> {
  const manifests = await step('database_unavailable', () => pool.query<{ object_key: string }>(
    `SELECT object_key FROM operations.document_manifests
     WHERE merchant_id=$1 AND customer_id=$2 AND document_type IN ('receipt','invoice')`,
    [merchantId, customerId],
  ));
  for (const { object_key: objectKey } of manifests.rows) {
    await step('storage_unavailable', async () => {
      const document = await getJsonObject(DOCUMENT_BUCKET, objectKey);
      if (!document) return;
      const redacted = anonymizeStoredDocument(document, customerId);
      const body = await putJsonObject(DOCUMENT_BUCKET, objectKey, redacted);
      await pool.query(
        `UPDATE operations.document_manifests SET checksum=$2 WHERE merchant_id=$3 AND object_key=$1`,
        [objectKey, createHash('sha256').update(body).digest('hex'), merchantId],
      );
    });
  }
}

async function anonymizeDatabaseRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
  await client.query(
    `UPDATE customers.customers
     SET email=$3,name=$4,phone=NULL,external_reference=$5,metadata='{}',status='erased',
         version=version+1,updated_at=now()
     WHERE merchant_id=$1 AND id=$2`,
    [merchantId, customerId, redactedEmail(customerId), REDACTED_NAME, redactedExternalReference(customerId)],
  );
  await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(
    `UPDATE customers.payment_method_refs
     SET provider_token='erased',brand=NULL,last4=NULL,billing_name=NULL,billing_address=NULL,status='erased'
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE customers.support_messages SET body='[redacted]',attachments='[]'
     WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
    [merchantId, customerId],
  );
  // Every support ticket currently has exactly one participant (its creator), so
  // it is safe to redact the subject line here without touching another
  // customer's shared record.
  await client.query(
    `UPDATE customers.support_tickets SET subject='[redacted]'
     WHERE merchant_id=$1 AND id IN (SELECT ticket_id FROM customers.support_participants WHERE customer_id=$2)`,
    [merchantId, customerId],
  );
  await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);

  const payments = await client.query<{ id: string; customer_snapshot: Record<string, unknown> }>(
    `SELECT id,customer_snapshot FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  for (const payment of payments.rows) {
    await client.query(
      `UPDATE payments.payment_intents SET customer_snapshot=$2 WHERE id=$1`,
      [payment.id, anonymizeCustomerSnapshot(payment.customer_snapshot, customerId)],
    );
  }

  const invoices = await client.query<{ id: string; billing_snapshot: Record<string, unknown> }>(
    `SELECT id,billing_snapshot FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  for (const invoice of invoices.rows) {
    await client.query(
      `UPDATE payments.invoices SET billing_snapshot=$2 WHERE id=$1`,
      [invoice.id, anonymizeCustomerSnapshot(invoice.billing_snapshot, customerId)],
    );
  }

  await client.query(
    `UPDATE payments.refunds r SET customer_email=$3
     FROM payments.payment_intents p
     WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
    [merchantId, customerId, redactedEmail(customerId)],
  );

  await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(
    `UPDATE operations.analytics_events SET email=NULL WHERE merchant_id=$1 AND customer_id=$2 AND email IS NOT NULL`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE platform.audit_logs SET metadata='{"redacted":true}'::jsonb
     WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE provider_sandbox.customers SET email=$3,name=$4
     WHERE merchant_id=$1 AND payflow_customer_id=$2`,
    [merchantId, customerId, redactedEmail(customerId), REDACTED_NAME],
  );

  const correlationId = randomUUID();
  await addOutboxEvent(client, {
    eventType: EVENT_TYPES.CUSTOMER_UPDATED, aggregateType: 'customer', aggregateId: customerId,
    merchantId, correlationId, payload: {
      customerId, email: redactedEmail(customerId), name: REDACTED_NAME, phone: null,
    },
  });
  await addOutboxEvent(client, {
    eventType: EVENT_TYPES.CUSTOMER_ERASURE_COMPLETED, aggregateType: 'customer', aggregateId: customerId,
    merchantId, correlationId, payload: { customerId },
  });
}

async function clearProjections(merchantId: string, customerId: string): Promise<void> {
  await step('cache_unavailable', () => redis.del(
    `merchant:${merchantId}:customer:${customerId}`,
    `merchant:${merchantId}:customer:${customerId}:activity`,
  ));
  await step('search_unavailable', async () => {
    try {
      await searchClient.delete({ index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}` });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
  });
}

/**
 * Erases a customer's personal data from every active PayFlow-controlled
 * system. Every step is idempotent so retries after a partial failure or a
 * worker restart converge on the same fully-redacted state without
 * duplicating destructive work.
 */
export async function eraseCustomerData(merchantId: string, customerId: string): Promise<void> {
  await purgeMail(merchantId, customerId);
  await redactStoredDocuments(merchantId, customerId);
  await step('database_unavailable', () => transaction((client) => anonymizeDatabaseRecords(client, merchantId, customerId)));
  await clearProjections(merchantId, customerId);
}
