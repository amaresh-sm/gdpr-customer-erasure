import type pg from 'pg';
import { v4 as uuid } from 'uuid';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../../packages/operations/src/retry-policy.js';
import {
  ERASED_CUSTOMER_TOMBSTONE,
  PII_PAYLOAD_KEYS,
  type ErasureRequestRecord,
} from '../../../packages/privacy/src/redact.js';

export interface CustomerIdentity {
  email: string;
  external_reference: string;
}

export class ErasureWorkerRepository {
  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',last_error='erasure_lease_expired',available_at=now()+interval '30 seconds',
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseSeconds = 120): Promise<ErasureRequestRecord | undefined> {
    return transaction(async (client) => {
      const result = await client.query<ErasureRequestRecord>(
        `UPDATE customers.erasure_requests
         SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
             lease_expires_at=now()+($2 || ' seconds')::interval,last_error=NULL,updated_at=now()
         WHERE id=(SELECT id FROM customers.erasure_requests
           WHERE status IN ('pending','failed') AND available_at<=now()
           ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING *`,
        [workerId, leaseSeconds],
      );
      return result.rows[0];
    });
  }

  /** Identifiers captured before anonymization, used to find customer import artifacts. */
  async customerIdentifiers(merchantId: string, customerId: string): Promise<CustomerIdentity | undefined> {
    const result = await pool.query<CustomerIdentity>(
      `SELECT email,external_reference FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  /**
   * Removes or anonymizes the customer's personal data in PostgreSQL. Financial
   * records (payments, invoices, ledger) keep their financial meaning but no
   * longer identify the customer. Every statement is idempotent so a resumed
   * workflow converges without duplicating destructive work.
   */
  async scrubCustomerData(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    importObjectKeys: string[],
  ): Promise<void> {
    const piiKeys = [...PII_PAYLOAD_KEYS];
    const tombstone = ERASED_CUSTOMER_TOMBSTONE;

    await client.query(
      `UPDATE customers.customers
       SET email='erased+' || id::text || '@erased.invalid', name='Erased customer', phone=NULL,
           external_reference='erased-' || id::text, metadata='{}'::jsonb, status='erased',
           version=version+1, updated_at=now()
       WHERE merchant_id=$1 AND id=$2 AND status<>'erased'`,
      [merchantId, customerId],
    );
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);

    await client.query(
      `DELETE FROM customers.support_messages WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM customers.support_participants WHERE customer_id=$1
       AND ticket_id IN (SELECT id FROM customers.support_tickets WHERE merchant_id=$2)`,
      [customerId, merchantId],
    );
    // Tickets left without participants are removed entirely; shared tickets stay usable.
    await client.query(
      `DELETE FROM customers.support_messages m WHERE m.merchant_id=$1
       AND NOT EXISTS(SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=m.ticket_id)`,
      [merchantId],
    );
    await client.query(
      `DELETE FROM customers.support_tickets t WHERE t.merchant_id=$1
       AND NOT EXISTS(SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id)`,
      [merchantId],
    );

    if (importObjectKeys.length > 0) {
      await client.query(
        `DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND object_key=ANY($2)`,
        [merchantId, importObjectKeys],
      );
      await client.query(
        `DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND object_key=ANY($2)`,
        [merchantId, importObjectKeys],
      );
    }

    await client.query(
      `UPDATE payments.payment_intents SET customer_snapshot=$3,description=NULL,updated_at=now()
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, tombstone],
    );
    await client.query(
      `UPDATE payments.payment_attempts a SET request_payload=a.request_payload - 'description'
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
      `UPDATE payments.invoices SET billing_snapshot=$3 WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, tombstone],
    );
    await client.query(
      `UPDATE payments.disputes d SET evidence='{}'::jsonb
       FROM payments.payment_intents p
       WHERE d.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );

    await client.query(
      `UPDATE operations.outbox_events SET payload=payload - $3::text[]
       WHERE merchant_id=$1 AND (payload->>'customerId'=$2 OR (aggregate_type='customer' AND aggregate_id=$2::uuid))`,
      [merchantId, customerId, piiKeys],
    );
    await client.query(
      `UPDATE operations.jobs SET payload=jsonb_set(payload,'{customerSnapshot}',$3::jsonb)
       WHERE merchant_id=$1 AND payload->>'customerId'=$2 AND payload ? 'customerSnapshot'`,
      [merchantId, customerId, tombstone],
    );
    await client.query(
      `UPDATE operations.dead_letters SET payload=payload - $3::text[]
       WHERE payload->>'merchantId'=$1 AND payload->>'customerId'=$2`,
      [merchantId, customerId, piiKeys],
    );
    await client.query(
      `UPDATE operations.dead_letters SET payload=jsonb_set(payload,'{customerSnapshot}',$3::jsonb)
       WHERE payload->>'merchantId'=$1 AND payload->>'customerId'=$2 AND payload ? 'customerSnapshot'`,
      [merchantId, customerId, tombstone],
    );
    await client.query(
      `UPDATE operations.analytics_events SET email=NULL,properties=properties - $3::text[]
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, piiKeys],
    );
    await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(
      `UPDATE platform.audit_logs SET metadata=metadata - $3::text[]
       WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`,
      [merchantId, customerId, piiKeys],
    );

    await client.query(
      `DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      [merchantId, customerId],
    );
  }

  /** Receipt and invoice objects retained for financial history that must be redacted. */
  async listRetainedDocumentKeys(merchantId: string, customerId: string): Promise<string[]> {
    const result = await pool.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests
       WHERE merchant_id=$1 AND customer_id=$2 AND document_type IN ('receipt','invoice')`,
      [merchantId, customerId],
    );
    return result.rows.map((row) => row.object_key);
  }

  async updateManifestChecksum(objectKey: string, checksum: string): Promise<void> {
    await pool.query(
      `UPDATE operations.document_manifests SET checksum=$2 WHERE object_key=$1`,
      [objectKey, checksum],
    );
  }

  async manifestExists(objectKey: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM operations.document_manifests WHERE object_key=$1`,
      [objectKey],
    );
    return Boolean(result.rowCount);
  }

  async complete(requestId: string, workerId: string): Promise<void> {
    await transaction(async (client) => {
      const updated = await client.query<{ merchant_id: string; customer_id: string }>(
        `UPDATE customers.erasure_requests
         SET status='completed',completed_at=now(),updated_at=now(),
             locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=NULL
         WHERE id=$1 AND locked_by=$2 RETURNING merchant_id,customer_id`,
        [requestId, workerId],
      );
      const row = updated.rows[0];
      if (!row) return;
      await client.query(
        `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
         VALUES($1,'system','customer',$2,'customer.erasure.completed',$3,$4)`,
        [row.merchant_id, row.customer_id, { requestId }, uuid()],
      );
    });
  }

  /** Marks the last attempt failed with a stable, customer-free error code; safe to retry. */
  async fail(request: ErasureRequestRecord, workerId: string, code: string): Promise<void> {
    const delaySeconds = boundedExponentialBackoffSeconds(request.attempts);
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',last_error=$3,available_at=now()+($4 || ' seconds')::interval,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND locked_by=$2`,
      [request.id, workerId, code, delaySeconds],
    );
  }
}
