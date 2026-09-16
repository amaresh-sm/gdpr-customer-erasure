import type { PoolClient } from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';

export interface EraseTarget {
  merchantId: string;
  customerId: string;
}

export async function eraseCustomerPII(client: PoolClient, target: EraseTarget): Promise<void> {
  const { merchantId, customerId } = target;

  // 1. Anonymize the main customer record: keep external_reference as part of retained deletion info
  await client.query(
    `UPDATE customers.customers
     SET email='redacted-' || id || '@deleted.local',
         name='Deleted Customer',
         phone=NULL,
         status='deleted',
         metadata='{}',
         updated_at=now()
     WHERE merchant_id=$1 AND id=$2`,
    [merchantId, customerId],
  );

  // 2. Remove personal addresses
  await client.query(
    `DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );

  // 3. Remove contacts
  await client.query(
    `DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );

  // 4. Anonymize payment method refs: keep last4/brand but remove billing_name and billing_address
  await client.query(
    `UPDATE customers.payment_method_refs
     SET billing_name=NULL, billing_address=NULL, provider_token='redacted'
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );

  // 5. Anonymize support messages (body may contain PII)
  await client.query(
    `UPDATE customers.support_messages
     SET body='[redacted]', attachments='[]'
     WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
    [merchantId, customerId],
  );

  // 6. Anonymize payment_intents customer_snapshot
  await client.query(
    `UPDATE payments.payment_intents
     SET customer_snapshot=jsonb_set(
           jsonb_set(
             jsonb_set(customer_snapshot, '{email}', '"redacted@deleted.local"'),
             '{name}', '"Deleted Customer"'
           ),
           '{phone}', 'null'
         ),
         updated_at=now()
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );

  // 7. Anonymize invoice billing_snapshot
  await client.query(
    `UPDATE payments.invoices
     SET billing_snapshot=jsonb_set(
           jsonb_set(
             jsonb_set(billing_snapshot, '{email}', '"redacted@deleted.local"'),
             '{name}', '"Deleted Customer"'
           ),
           '{phone}', 'null'
         ),
         updated_at=now()
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );

  // 8. Anonymize refunds customer_email field
  await client.query(
    `UPDATE payments.refunds
     SET customer_email='redacted@deleted.local'
     WHERE merchant_id=$1 AND customer_id=$2
       AND customer_email IS NOT NULL`,
    [merchantId, customerId],
  );

  // 9. Remove from provider sandbox
  await client.query(
    `DELETE FROM provider_sandbox.customers
     WHERE merchant_id=$1 AND payflow_customer_id=$2`,
    [merchantId, customerId],
  );

  // 10. Cancel pending email deliveries
  await client.query(
    `UPDATE operations.email_deliveries
     SET status='cancelled', cancelled_at=now()
     WHERE merchant_id=$1 AND customer_id=$2 AND status IN ('pending','processing')`,
    [merchantId, customerId],
  );

  // 11. Remove notification preferences
  await client.query(
    `DELETE FROM operations.notification_preferences
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );

  // 12. Remove from OpenSearch
  try {
    await searchClient.delete({
      index: CUSTOMER_INDEX,
      id: `${merchantId}:${customerId}`,
      refresh: true,
    });
  } catch {
    // Document may not exist in search index, that's fine
  }

  // 13. Remove stored documents (invoices, receipts, imports) for this customer
  const manifests = await client.query<{ object_key: string }>(
    `SELECT object_key FROM operations.document_manifests
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  await ensureBucket();
  for (const row of manifests.rows) {
    try {
      await objectStore.removeObject(DOCUMENT_BUCKET, row.object_key);
    } catch {
      // Object may not exist
    }
  }
  await client.query(
    `DELETE FROM operations.document_manifests
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
}