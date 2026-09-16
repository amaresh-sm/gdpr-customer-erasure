import type pg from 'pg';
import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';
import { anonymizedIdentity } from './erasure-repository.js';

export class CustomerNotFoundForErasureError extends Error {
  constructor() {
    super('customer not found');
  }
}

interface RedactableDocument {
  objectKey: string;
  kind: 'invoice' | 'receipt';
}

/**
 * Anonymizes every PayFlow-controlled record that identifies this customer while
 * preserving the financial facts (amounts, statuses, references) other systems rely on.
 * Every statement here is idempotent so retries and replays converge on the same result
 * instead of re-doing (or undoing) destructive work.
 */
export async function eraseCustomerData(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
  const customer = await client.query(
    `SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
    [merchantId, customerId],
  );
  if (!customer.rows[0]) throw new CustomerNotFoundForErasureError();

  const identity = anonymizedIdentity(customerId);

  await client.query(
    `UPDATE customers.customers
     SET email=$3,name=$4,phone=NULL,external_reference=$5,metadata='{}',status='erased',
         version=version+1,updated_at=now()
     WHERE merchant_id=$1 AND id=$2`,
    [merchantId, customerId, identity.email, identity.name, identity.externalReference],
  );

  await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);

  await client.query(
    `UPDATE customers.support_messages SET body='[redacted]'
     WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2 AND body<>'[redacted]'`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE customers.support_tickets t SET subject='[redacted]'
     WHERE t.merchant_id=$1 AND t.subject<>'[redacted]' AND EXISTS(
       SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id AND p.customer_id=$2
     ) AND NOT EXISTS(
       SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id AND p.customer_id<>$2
     )`,
    [merchantId, customerId],
  );

  await client.query(
    `UPDATE payments.payment_intents
     SET customer_snapshot=jsonb_build_object('id',customer_id,'status','erased'),updated_at=now()
     WHERE merchant_id=$1 AND customer_id=$2 AND customer_snapshot->>'status'<>'erased'`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE payments.refunds r SET customer_email=NULL
     WHERE r.merchant_id=$1 AND r.customer_email IS NOT NULL AND r.payment_intent_id IN (
       SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
     )`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE payments.invoices
     SET billing_snapshot=jsonb_build_object('customerId',customer_id,'redacted',true)
     WHERE merchant_id=$1 AND customer_id=$2 AND billing_snapshot->>'redacted' IS DISTINCT FROM 'true'`,
    [merchantId, customerId],
  );

  await client.query(
    `UPDATE operations.analytics_events
     SET email=NULL, properties=(properties - 'email' - 'customerEmail' - 'name' - 'phone' - 'billingName')
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);

  await client.query(
    `UPDATE operations.jobs
     SET payload=jsonb_set(payload,'{customerSnapshot}','{"redacted":true}'::jsonb)
     WHERE merchant_id=$1 AND job_type='generate_receipt' AND payload->>'customerId'=$2
       AND payload->'customerSnapshot'->>'redacted' IS DISTINCT FROM 'true'`,
    [merchantId, customerId],
  );

  await client.query(
    `UPDATE provider_sandbox.customers
     SET email=$3,name=$4,external_reference=$5,updated_at=now()
     WHERE merchant_id=$1 AND payflow_customer_id=$2`,
    [merchantId, customerId, identity.email, identity.name, identity.externalReference],
  );

  const redactableDocuments = await client.query<{ object_key: string; document_type: 'invoice' | 'receipt' }>(
    `SELECT object_key,document_type FROM operations.document_manifests
     WHERE merchant_id=$1 AND customer_id=$2 AND document_type IN ('invoice','receipt')`,
    [merchantId, customerId],
  );
  const documents: RedactableDocument[] = redactableDocuments.rows.map((row) => ({
    objectKey: row.object_key, kind: row.document_type,
  }));
  await redactStoredDocuments(documents, customerId);

  await addOutboxEvent(client, {
    eventType: EVENT_TYPES.CUSTOMER_ERASED, aggregateType: 'customer', aggregateId: customerId,
    merchantId, correlationId: uuid(), payload: { customerId },
  });
}

/** Overwrites retained financial documents in object storage so they no longer expose PII. */
async function redactStoredDocuments(documents: RedactableDocument[], customerId: string): Promise<void> {
  if (!documents.length) return;
  await ensureBucket();
  for (const document of documents) {
    const redacted = JSON.stringify({ customerId, redacted: true, kind: document.kind });
    await objectStore.putObject(DOCUMENT_BUCKET, document.objectKey, redacted, Buffer.byteLength(redacted), {
      'Content-Type': 'application/json',
    });
  }
}
