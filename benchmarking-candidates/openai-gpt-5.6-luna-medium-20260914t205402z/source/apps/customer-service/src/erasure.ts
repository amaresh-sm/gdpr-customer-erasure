import type pg from 'pg';
import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';

export type ErasureRequest = {
  id: string;
  customerId: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
};

type ErasureRow = {
  id: string; customer_id: string; status: ErasureRequest['status']; attempts: number;
  created_at: Date; updated_at: Date; completed_at: Date | null; last_error: string | null;
};

function present(row: ErasureRow): ErasureRequest {
  return {
    id: row.id, customerId: row.customer_id, status: row.status, attempts: row.attempts,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null, lastError: row.last_error,
  };
}

export class ErasureService {
  async request(merchantId: string, customerId: string, idempotencyKey: string): Promise<ErasureRequest> {
    return transaction(async (client) => {
      const keyed = await client.query<ErasureRow & { merchant_id: string }>(
        `SELECT id,merchant_id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error
         FROM operations.erasure_requests WHERE merchant_id=$1 AND idempotency_key=$2`,
        [merchantId, idempotencyKey],
      );
      if (keyed.rows[0]) {
        if (keyed.rows[0].customer_id !== customerId) {
          throw Object.assign(new Error('idempotency key reused for a different customer'), { statusCode: 409 });
        }
        if (keyed.rows[0].status === 'failed') {
          await this.requeue(client, keyed.rows[0].id, merchantId, customerId);
          keyed.rows[0].status = 'pending';
          keyed.rows[0].last_error = null;
        }
        return present(keyed.rows[0]);
      }

      const customer = await client.query(
        `SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId],
      );
      if (!customer.rowCount) throw Object.assign(new Error('customer not found'), { statusCode: 404 });

      const existing = await client.query<ErasureRow>(
        `SELECT id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error
         FROM operations.erasure_requests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].status === 'failed') {
          await this.requeue(client, existing.rows[0].id, merchantId, customerId);
          existing.rows[0].status = 'pending';
          existing.rows[0].last_error = null;
        }
        return present(existing.rows[0]);
      }

      const created = await client.query<ErasureRow>(
        `INSERT INTO operations.erasure_requests(merchant_id,customer_id,idempotency_key)
         VALUES($1,$2,$3)
         RETURNING id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`,
        [merchantId, customerId, idempotencyKey],
      );
      await client.query(
        `INSERT INTO operations.jobs(queue,job_type,merchant_id,payload)
         VALUES('privacy','erase_customer',$1,$2)`,
        [merchantId, { erasureRequestId: created.rows[0]!.id, customerId }],
      );
      return present(created.rows[0]!);
    });
  }

  async status(merchantId: string, requestId: string): Promise<ErasureRequest | undefined> {
    const result = await pool.query<ErasureRow>(
      `SELECT id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error
       FROM operations.erasure_requests WHERE merchant_id=$1 AND id=$2`, [merchantId, requestId],
    );
    return result.rows[0] ? present(result.rows[0]) : undefined;
  }

  private async requeue(client: pg.PoolClient, requestId: string, merchantId: string, customerId: string): Promise<void> {
    await client.query(`UPDATE operations.erasure_requests SET status='pending',updated_at=now(),last_error=NULL WHERE id=$1`, [requestId]);
    await client.query(
      `INSERT INTO operations.jobs(queue,job_type,merchant_id,payload) VALUES('privacy','erase_customer',$1,$2)`,
      [merchantId, { erasureRequestId: requestId, customerId }],
    );
  }

  static async erase(client: pg.PoolClient, requestId: string, merchantId: string, customerId: string): Promise<void> {
    await client.query(`SELECT id FROM operations.erasure_requests WHERE id=$1 AND merchant_id=$2 AND customer_id=$3 FOR UPDATE`,
      [requestId, merchantId, customerId]);
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.support_messages WHERE merchant_id=$1 AND author_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);

    await client.query(`UPDATE payments.refunds SET customer_email=NULL WHERE merchant_id=$1 AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [merchantId, customerId]);
    await client.query(`UPDATE payments.payment_intents SET customer_id=NULL,customer_snapshot='{}'::jsonb WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE payments.invoices SET customer_id=NULL,billing_snapshot='{}'::jsonb WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE operations.notifications SET customer_id=NULL,destination=NULL,payload='{}'::jsonb WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE operations.email_deliveries SET customer_id=NULL,destination=NULL,text_body='[redacted]',html_body='[redacted]',subject='[redacted]',status=CASE WHEN status IN ('pending','processing') THEN 'cancelled' ELSE status END,cancelled_at=CASE WHEN status IN ('pending','processing') THEN now() ELSE cancelled_at END WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE operations.outbox_events SET payload='{}'::jsonb WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2)`, [merchantId, customerId]);
    await client.query(`UPDATE platform.audit_logs SET metadata='{}'::jsonb WHERE merchant_id=$1 AND target_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.jobs WHERE merchant_id=$1 AND payload->>'customerId'=$2 AND job_type<>'erase_customer'`, [merchantId, customerId]);
    await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE customers.customers SET external_reference=NULL,email=NULL,name=NULL,phone=NULL,metadata='{}'::jsonb,status='erased',version=version+1,updated_at=now() WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
    await addOutboxEvent(client, {
      eventType: EVENT_TYPES.CUSTOMER_ERASED, aggregateType: 'customer', aggregateId: customerId,
      merchantId, correlationId: uuid(), payload: { customerId },
    });
    await client.query(`UPDATE operations.erasure_requests SET status='completed',updated_at=now(),completed_at=now(),last_error=NULL WHERE id=$1`, [requestId]);
  }
}
