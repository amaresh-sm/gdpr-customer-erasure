import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../../packages/contracts/src/events.js';
import { advisoryLock, pool, transaction } from '../../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../../packages/messaging/src/outbox.js';
import { requestHash, reserveIdempotency, completeIdempotency } from '../../../../packages/operations/src/idempotency.js';
import { boundedExponentialBackoffSeconds } from '../../../../packages/operations/src/retry-policy.js';
import { buildErasedCustomerSnapshot } from '../../../../packages/privacy/src/snapshot.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  target_emails: string[];
  last_error: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type ClaimedErasureRequest = ErasureRequestRow;

export interface InvoiceToRewrite {
  id: string;
  object_key: string | null;
  number: string;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  issued_at: Date | null;
}

export interface ReceiptToRewrite {
  payment_id: string;
  object_key: string;
  amount: string;
  currency: string;
}

export interface ErasureDbStepResult {
  invoicesToRewrite: InvoiceToRewrite[];
  receiptsToRewrite: ReceiptToRewrite[];
  importObjectKeysToDelete: string[];
}

/** Idempotency scope shared by every attempt to create a customer's erasure request. */
export const ERASURE_IDEMPOTENCY_SCOPE = 'customer-erasure-request';

export class ErasureRepository {
  async findCustomer(merchantId: string, customerId: string): Promise<{ id: string } | undefined> {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT id,merchant_id,customer_id,status,attempts,target_emails,last_error,completed_at,created_at,updated_at
       FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  /**
   * Creates (or resumes) the single erasure workflow for a customer, replaying
   * an idempotency key that was already used for this exact request and
   * rejecting one reused for a different customer.
   */
  async createOrResume(
    merchantId: string, customerId: string, idempotencyKey: string,
  ): Promise<{ status: number; body: ErasureRequestRow }> {
    const hash = requestHash({ customerId });
    return await transaction(async (client) => {
      const replay = await reserveIdempotency(client, merchantId, ERASURE_IDEMPOTENCY_SCOPE, idempotencyKey, hash);
      if (replay) return { status: replay.status, body: replay.body as ErasureRequestRow };

      const inserted = await client.query<ErasureRequestRow>(
        `INSERT INTO customers.erasure_requests(merchant_id,customer_id,target_emails)
         SELECT $1,$2,ARRAY(
           SELECT DISTINCT email FROM (
             SELECT email FROM customers.customers WHERE id=$2
             UNION
             SELECT value FROM customers.contacts WHERE customer_id=$2 AND kind='email'
           ) addresses
         )
         ON CONFLICT(merchant_id,customer_id) DO NOTHING
         RETURNING id,merchant_id,customer_id,status,attempts,target_emails,last_error,completed_at,created_at,updated_at`,
        [merchantId, customerId],
      );
      const created = inserted.rows[0];
      const row = created ?? (await client.query<ErasureRequestRow>(
        `SELECT id,merchant_id,customer_id,status,attempts,target_emails,last_error,completed_at,created_at,updated_at
         FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      )).rows[0]!;

      if (created) {
        await addOutboxEvent(client, {
          eventType: EVENT_TYPES.CUSTOMER_ERASURE_REQUESTED, aggregateType: 'customer', aggregateId: customerId,
          merchantId, correlationId: uuid(), payload: { customerId, requestId: row.id },
        });
      }

      await completeIdempotency(client, merchantId, ERASURE_IDEMPOTENCY_SCOPE, idempotencyKey, 202, row);
      return { status: 202, body: row };
    });
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
           last_error=COALESCE(last_error,'erasure_worker_lease_expired')
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseSeconds = 120): Promise<ClaimedErasureRequest | undefined> {
    const result = await pool.query<ClaimedErasureRequest>(
      `UPDATE customers.erasure_requests
       SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval,last_error=NULL
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status IN ('pending','failed') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,customer_id,status,attempts,target_emails,last_error,completed_at,created_at,updated_at`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  }

  async markCompleted(id: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='completed',completed_at=now(),target_emails='{}',last_error=NULL,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1`,
      [id],
    );
  }

  async markFailed(id: string, attempts: number, errorCode: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',available_at=now()+($3 || ' seconds')::interval,last_error=$2,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1`,
      [id, errorCode, boundedExponentialBackoffSeconds(attempts)],
    );
  }

  /**
   * Applies every in-database redaction step for a customer within one
   * transaction. Every statement is deterministic and guarded by identity,
   * so re-running the whole step on retry converges on the same result
   * without restoring or duplicating anything.
   */
  async runDatabaseStep(merchantId: string, customerId: string): Promise<ErasureDbStepResult> {
    return await transaction(async (client) => {
      await advisoryLock(client, `customer-erasure:${customerId}`);

      const snapshot = buildErasedCustomerSnapshot(customerId);
      await client.query(
        `UPDATE customers.customers
         SET email=$3,name=$4,phone=NULL,external_reference=$5,metadata='{}',status=$6,
             version=version+1,updated_at=now()
         WHERE merchant_id=$1 AND id=$2`,
        [merchantId, customerId, snapshot.email, snapshot.name, snapshot.external_reference, snapshot.status],
      );

      await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);

      await client.query(
        `UPDATE payments.payment_intents SET customer_snapshot=$3::jsonb,updated_at=now()
         WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId, JSON.stringify(snapshot)],
      );
      await client.query(
        `UPDATE payments.refunds r SET customer_email=NULL
         FROM payments.payment_intents p
         WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
        [merchantId, customerId],
      );
      const invoices = await client.query<InvoiceToRewrite>(
        `UPDATE payments.invoices SET billing_snapshot=$3::jsonb
         WHERE merchant_id=$1 AND customer_id=$2
         RETURNING id,object_key,number,currency,subtotal::text,tax::text,total::text,issued_at`,
        [merchantId, customerId, JSON.stringify(snapshot)],
      );

      const receipts = await client.query<ReceiptToRewrite>(
        `SELECT (d.metadata->>'paymentId') payment_id,d.object_key,p.amount::text,p.currency
         FROM operations.document_manifests d
         JOIN payments.payment_intents p ON p.id::text=d.metadata->>'paymentId'
         WHERE d.merchant_id=$1 AND d.customer_id=$2 AND d.document_type='receipt'`,
        [merchantId, customerId],
      );

      await client.query(
        `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      );
      await client.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(
        `UPDATE operations.analytics_events SET email=NULL,properties='{}'::jsonb
         WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      );

      await client.query(
        `UPDATE customers.support_messages SET body='[redacted]'
         WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `UPDATE customers.support_tickets t SET subject='[redacted]'
         FROM customers.support_participants sp
         WHERE sp.ticket_id=t.id AND sp.customer_id=$2 AND t.merchant_id=$1`,
        [merchantId, customerId],
      );
      await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);

      await client.query(
        `UPDATE platform.audit_logs SET metadata='{}'::jsonb
         WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`,
        [merchantId, customerId],
      );

      const imports = await client.query<{ object_key: string }>(
        `SELECT object_key FROM customers.customer_imports WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM operations.document_manifests
         WHERE merchant_id=$1 AND customer_id=$2 AND document_type='customer_import'`,
        [merchantId, customerId],
      );
      await client.query(`DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);

      await client.query(
        `UPDATE provider_sandbox.customers SET email=$3,name=$4,external_reference=$5,updated_at=now()
         WHERE merchant_id=$1 AND payflow_customer_id=$2`,
        [merchantId, customerId, snapshot.email, snapshot.name, snapshot.external_reference],
      );

      return {
        invoicesToRewrite: invoices.rows,
        receiptsToRewrite: receipts.rows,
        importObjectKeysToDelete: imports.rows.map((row) => row.object_key),
      };
    });
  }

  async invoiceLines(invoiceId: string): Promise<Array<{ description: string; quantity: number; unit_amount: string; total: string }>> {
    const result = await pool.query<{ description: string; quantity: number; unit_amount: string; total: string }>(
      `SELECT description,quantity,unit_amount::text,total::text FROM payments.invoice_lines WHERE invoice_id=$1`,
      [invoiceId],
    );
    return result.rows;
  }

  async updateManifestChecksum(objectKey: string, checksum: string): Promise<void> {
    await pool.query(`UPDATE operations.document_manifests SET checksum=$2 WHERE object_key=$1`, [objectKey, checksum]);
  }
}
