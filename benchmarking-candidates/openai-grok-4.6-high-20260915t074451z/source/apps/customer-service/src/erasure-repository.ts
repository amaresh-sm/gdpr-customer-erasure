import type { PoolClient } from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import { erasedCustomerRecord } from '../../../packages/privacy/src/redact.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface CustomerPiiSnapshot {
  email: string;
  name: string;
  phone: string | null;
  external_reference: string;
}

export class ErasureRepository {
  async findCustomer(client: PoolClient, merchantId: string, customerId: string): Promise<CustomerPiiSnapshot | undefined> {
    const result = await client.query<CustomerPiiSnapshot>(
      `SELECT email,name,phone,external_reference FROM customers.customers
       WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async markCustomerErasing(client: PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(
      `UPDATE customers.customers SET status='erased', version=version+1, updated_at=now()
       WHERE merchant_id=$1 AND id=$2 AND status<>'erased'`,
      [merchantId, customerId],
    );
  }

  async findExisting(client: PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async create(client: PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id,status)
       VALUES($1,$2,'pending') RETURNING *`,
      [merchantId, customerId],
    );
    return result.rows[0]!;
  }

  async requeue(client: PoolClient, request: ErasureRequestRow): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='pending', last_error=NULL, updated_at=now()
       WHERE id=$1 AND merchant_id=$2 AND status='failed' RETURNING *`,
      [request.id, request.merchant_id],
    );
    return result.rows[0] ?? request;
  }

  async findForMerchant(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async claimRunnable(): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='processing', attempts=attempts+1, updated_at=now(), last_error=NULL
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status IN ('pending','failed')
         ORDER BY updated_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
    );
    return result.rows[0];
  }

  async markFailed(requestId: string, errorCode: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed', last_error=$2, updated_at=now()
       WHERE id=$1 AND status='processing'`,
      [requestId, errorCode],
    );
  }

  async markCompleted(client: PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='completed', last_error=NULL, completed_at=now(), updated_at=now()
       WHERE id=$1`,
      [requestId],
    );
  }

  async ensureTombstone(client: PoolClient, merchantId: string, customerId: string, requestId: string): Promise<void> {
    await client.query(
      `INSERT INTO customers.erasure_tombstones(merchant_id,customer_id,erasure_request_id)
       VALUES($1,$2,$3) ON CONFLICT(merchant_id,customer_id) DO NOTHING`,
      [merchantId, customerId, requestId],
    );
  }

  async redactOperationalRecords(client: PoolClient, merchantId: string, customerId: string): Promise<void> {
    const placeholder = erasedCustomerRecord(customerId);
    await client.query(
      `UPDATE customers.support_tickets SET subject='erased'
       WHERE merchant_id=$1 AND id IN (
         SELECT ticket_id FROM customers.support_participants WHERE customer_id=$2
       ) AND NOT EXISTS (
         SELECT 1 FROM customers.support_participants other
         WHERE other.ticket_id=customers.support_tickets.id AND other.customer_id<>$2
       )`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE customers.support_messages
       SET author_id=NULL, body='erased'
       WHERE merchant_id=$1 AND author_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM customers.support_participants WHERE customer_id=$1
       AND ticket_id IN (SELECT id FROM customers.support_tickets WHERE merchant_id=$2)`,
      [customerId, merchantId],
    );
    await client.query(
      `UPDATE customers.customers
       SET email=$3,name='erased',phone=NULL,external_reference=$4,metadata='{}'::jsonb,
           status='erased',version=version+1,updated_at=now()
       WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId, `erased+${customerId}@erased.invalid`, `erased:${customerId}`],
    );
    await client.query(
      `DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE customers.payment_method_refs
       SET provider_token='erased', billing_name=NULL, billing_address=NULL, last4=NULL, status='erased'
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.payment_intents
       SET customer_snapshot=$3::jsonb, description=NULL
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, placeholder],
    );
    await client.query(
      `UPDATE payments.payment_attempts
       SET request_payload = COALESCE(request_payload,'{}'::jsonb)
             - 'email' - 'name' - 'phone' - 'customerEmail' - 'billingName' - 'billingAddress'
             || '{"erased":true}'::jsonb,
           response_payload = CASE WHEN response_payload IS NULL THEN NULL
             ELSE response_payload - 'email' - 'name' - 'phone' - 'customerEmail' || '{"erased":true}'::jsonb END
       WHERE merchant_id=$1 AND payment_intent_id IN (
         SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
       )`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.refunds SET customer_email=NULL
       WHERE merchant_id=$1 AND payment_intent_id IN (
         SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
       )`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.disputes SET evidence='{}'::jsonb
       WHERE merchant_id=$1 AND payment_intent_id IN (
         SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
       )`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.invoices SET billing_snapshot=$3::jsonb
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, placeholder],
    );
    await client.query(
      `UPDATE operations.analytics_events
       SET email=NULL, anonymous_id=NULL, properties=$3::jsonb
       WHERE merchant_id=$1 AND (customer_id=$2 OR properties->>'customerId'=$2)`,
      [merchantId, customerId, { erased: true }],
    );
    await client.query(
      `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.notifications
       SET destination='erased', payload=$3::jsonb, last_error=NULL
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, { erased: true }],
    );
    await client.query(
      `UPDATE operations.email_deliveries
       SET destination='erased', subject='erased', text_body='erased', html_body='erased',
           status=CASE WHEN status IN ('pending','processing','failed') THEN 'cancelled' ELSE status END,
           cancelled_at=CASE WHEN status IN ('pending','processing','failed') THEN now() ELSE cancelled_at END,
           locked_by=NULL, locked_at=NULL, lease_expires_at=NULL
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.jobs
       SET payload = COALESCE(payload,'{}'::jsonb)
             - 'customerSnapshot' - 'email' - 'customerEmail' - 'name' - 'phone'
             || '{"erased":true}'::jsonb
       WHERE merchant_id=$1 AND payload->>'customerId'=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.inbox_events SET error=NULL
       WHERE event_id IN (
         SELECT id FROM operations.outbox_events
         WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2)
       )`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.outbox_events
       SET payload = COALESCE(payload,'{}'::jsonb)
             - 'email' - 'customerEmail' - 'name' - 'phone' - 'customer'
             - 'subject' - 'body' - 'line1' - 'line2' - 'city' - 'region'
             - 'postalCode' - 'billingName' - 'billingAddress'
             || '{"erased":true}'::jsonb
       WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2)`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.document_manifests
       SET metadata = COALESCE(metadata,'{}'::jsonb) || '{"erased":true}'::jsonb
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE platform.audit_logs
       SET metadata=$3::jsonb
       WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`,
      [merchantId, customerId, { erased: true }],
    );
    await client.query(
      `UPDATE provider_sandbox.customers
       SET email=$3, name='erased', external_reference=$4, updated_at=now()
       WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      [merchantId, customerId, `erased+${customerId}@erased.invalid`, `erased:${customerId}`],
    );
    await client.query(
      `UPDATE operations.dead_letters
       SET payload = COALESCE(payload,'{}'::jsonb)
             - 'email' - 'customerEmail' - 'name' - 'phone' - 'customer' - 'customerSnapshot'
             || '{"erased":true}'::jsonb
       WHERE payload->>'customerId'=$1 OR source_id=$1`,
      [customerId],
    );
  }

  async listMerchantObjectKeys(merchantId: string, customerId: string): Promise<string[]> {
    const result = await pool.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests
       WHERE merchant_id=$1 AND (customer_id=$2 OR document_type='customer_import')
       UNION
       SELECT object_key FROM customers.customer_imports WHERE merchant_id=$1`,
      [merchantId, customerId],
    );
    return result.rows.map((row) => row.object_key);
  }

  async listCustomerEmails(merchantId: string, customerId: string, liveEmail: string | null): Promise<string[]> {
    const result = await pool.query<{ destination: string }>(
      `SELECT DISTINCT destination FROM (
         SELECT destination FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2
         UNION
         SELECT destination FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2
         UNION
         SELECT destination FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2
       ) destinations WHERE destination IS NOT NULL AND destination <> '' AND destination <> 'erased'`,
      [merchantId, customerId],
    );
    const emails = result.rows.map((row) => row.destination);
    if (liveEmail && !emails.includes(liveEmail)) emails.push(liveEmail);
    return emails;
  }

  async updateDocumentChecksum(client: PoolClient, objectKey: string, checksum: string): Promise<void> {
    await client.query(
      `UPDATE operations.document_manifests
       SET checksum=$2, metadata=COALESCE(metadata,'{}'::jsonb) || '{"erased":true}'::jsonb
       WHERE object_key=$1`,
      [objectKey, checksum],
    );
  }
}
