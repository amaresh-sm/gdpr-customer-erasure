import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { config } from '../../../packages/config/src/index.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { logger } from '../../../packages/observability/src/logger.js';

export type ErasureStatus = 'pending' | 'processing' | 'failed' | 'completed';

interface ErasureRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: ErasureStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ErasureRequest {
  id: string;
  customerId: string;
  status: ErasureStatus;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  lastError: string | null;
}

function present(row: ErasureRow): ErasureRequest {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}

export class ErasureService {
  private redis: Redis | undefined;

  async request(merchantId: string, customerId: string, key: string): Promise<ErasureRequest | undefined> {
    return await transaction(async (client) => {
      const customer = await client.query(
        `SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
        [merchantId, customerId],
      );
      if (!customer.rowCount) return undefined;

      const keyed = await client.query<{ customer_id: string; request_id: string }>(
        `SELECT customer_id,request_id FROM customers.erasure_idempotency_keys
         WHERE merchant_id=$1 AND key=$2 FOR UPDATE`,
        [merchantId, key],
      );
      if (keyed.rows[0] && keyed.rows[0].customer_id !== customerId) {
        throw Object.assign(new Error('idempotency_key_reused'), { statusCode: 409 });
      }

      let request: ErasureRow | undefined;
      if (keyed.rows[0]) {
        request = await this.getForUpdate(client, keyed.rows[0].request_id);
      } else {
        const existing = await client.query<ErasureRow>(
          `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
          [merchantId, customerId],
        );
        request = existing.rows[0];
        if (!request) {
          const created = await client.query<ErasureRow>(
            `INSERT INTO customers.erasure_requests(merchant_id,customer_id,status)
             VALUES($1,$2,'pending') RETURNING *`,
            [merchantId, customerId],
          );
          request = created.rows[0]!;
          await client.query(
            `UPDATE customers.customers SET status='erasing',updated_at=now() WHERE merchant_id=$1 AND id=$2 AND status='active'`,
            [merchantId, customerId],
          );
        }
        await client.query(
          `INSERT INTO customers.erasure_idempotency_keys(merchant_id,key,customer_id,request_id)
           VALUES($1,$2,$3,$4)`,
          [merchantId, key, customerId, request.id],
        );
      }
      if (!request) throw new Error('erasure request missing');
      if (request.status === 'failed') {
        const resumed = await client.query<ErasureRow>(
          `UPDATE customers.erasure_requests SET status='pending',last_error=NULL,updated_at=now()
           WHERE id=$1 RETURNING *`,
          [request.id],
        );
        request = resumed.rows[0]!;
      }
      return present(request);
    });
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequest | undefined> {
    const result = await pool.query<ErasureRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0] ? present(result.rows[0]) : undefined;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.redis = new Redis(config().REDIS_URL);
    await pool.query(`UPDATE customers.erasure_requests SET status='pending',updated_at=now()
      WHERE status='processing'`);
    while (!signal.aborted) {
      try {
        const request = await this.claim();
        if (!request) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        try {
          await this.erase(request);
          await pool.query(
            `UPDATE customers.erasure_requests
             SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL WHERE id=$1`,
            [request.id],
          );
        } catch (error) {
          logger.error({ err: error, requestId: request.id }, 'customer erasure cleanup failed');
          await pool.query(
            `UPDATE customers.erasure_requests SET status='failed',last_error='erasure_cleanup_failed',updated_at=now()
             WHERE id=$1`,
            [request.id],
          );
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    await this.redis?.quit();
  }

  private async claim(): Promise<ErasureRow | undefined> {
    const result = await pool.query<ErasureRow>(
      `UPDATE customers.erasure_requests SET status='processing',attempts=attempts+1,updated_at=now(),last_error=NULL
       WHERE id=(SELECT id FROM customers.erasure_requests WHERE status='pending'
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    );
    return result.rows[0];
  }

  private async erase(request: ErasureRow): Promise<void> {
    const objectKeys = await this.objectKeys(request.merchant_id, request.customer_id);
    for (const objectKey of objectKeys) await objectStore.removeObject(DOCUMENT_BUCKET, objectKey);
    await searchClient.delete({ index: CUSTOMER_INDEX, id: `${request.merchant_id}:${request.customer_id}` }).catch((error: { statusCode?: number; meta?: { statusCode?: number } }) => {
      if (error.statusCode !== 404 && error.meta?.statusCode !== 404) throw error;
    });
    await this.redis!.del(`merchant:${request.merchant_id}:customer:${request.customer_id}`);
    await this.redis!.del(`merchant:${request.merchant_id}:customer:${request.customer_id}:activity`);
    await transaction(async (client) => this.scrub(client, request));
  }

  private async objectKeys(merchantId: string, customerId: string): Promise<string[]> {
    const result = await pool.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    return result.rows.map((row) => row.object_key);
  }

  private async scrub(client: pg.PoolClient, request: ErasureRow): Promise<void> {
    const { merchant_id: merchantId, customer_id: customerId } = request;
    const customer = await client.query<{ email: string; external_reference: string }>(
      `SELECT email,external_reference FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    const identity = customer.rows[0];
    if (identity) {
      await client.query(
        `INSERT INTO customers.erasure_tombstones(merchant_id,customer_id,email_hmac,external_reference_hmac)
         VALUES($1,$2,$3,$4) ON CONFLICT(merchant_id,customer_id) DO NOTHING`,
        [merchantId, customerId, this.identityHash(identity.email), this.identityHash(identity.external_reference)],
      );
    }
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE customers.support_tickets t SET subject='Erased support ticket' WHERE merchant_id=$1 AND EXISTS
      (SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id AND p.customer_id=$2)`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.support_messages WHERE merchant_id=$1 AND author_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);
    await client.query(`DELETE FROM customers.support_tickets t WHERE merchant_id=$1 AND NOT EXISTS
      (SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id)`, [merchantId]);
    await client.query(`DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM platform.audit_logs WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2::text`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.outbox_events WHERE merchant_id=$1 AND
      (aggregate_type='customer' AND aggregate_id=$2 OR payload->>'customerId'=$2::text)`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.jobs WHERE merchant_id=$1 AND payload->>'customerId'=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.idempotency_keys WHERE merchant_id=$1 AND response_body->>'customerId'=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.dead_letters WHERE payload->>'customerId'=$1`, [customerId]);
    await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE operations.email_deliveries SET customer_id=NULL,destination='erased@invalid',subject='Erased',
      text_body='',html_body='',status='cancelled',locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=NULL
      WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE operations.notifications SET customer_id=NULL,destination='erased@invalid',payload='{}'::jsonb,
      status='cancelled',updated_at=now(),last_error=NULL WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE payments.payment_attempts a SET request_payload='{}'::jsonb,response_payload='{}'::jsonb,
      failure_message=NULL WHERE a.merchant_id=$1 AND EXISTS
      (SELECT 1 FROM payments.payment_intents p WHERE p.id=a.payment_intent_id AND p.customer_id=$2)`, [merchantId, customerId]);
    await client.query(`UPDATE payments.refunds r SET customer_email=NULL WHERE r.merchant_id=$1 AND EXISTS
      (SELECT 1 FROM payments.payment_intents p WHERE p.id=r.payment_intent_id AND p.customer_id=$2)`, [merchantId, customerId]);
    await client.query(`UPDATE payments.disputes d SET evidence='{}'::jsonb WHERE d.merchant_id=$1 AND EXISTS
      (SELECT 1 FROM payments.payment_intents p WHERE p.id=d.payment_intent_id AND p.customer_id=$2)`, [merchantId, customerId]);
    await client.query(`UPDATE payments.invoices SET customer_id=NULL,billing_snapshot='{}'::jsonb,object_key=NULL
      WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE provider_sandbox.payment_intents s SET provider_customer_id=NULL WHERE EXISTS
      (SELECT 1 FROM payments.payment_intents p WHERE p.id=s.payment_id AND p.merchant_id=$1 AND p.customer_id=$2)`, [merchantId, customerId]);
    await client.query(`UPDATE payments.payment_intents SET customer_id=NULL,payment_method_id=NULL,customer_snapshot='{}'::jsonb,
      description='Erased payment record' WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE customers.customers SET external_reference='erased_' || id::text,
      email='erased_' || id::text || '@invalid.local',name='Erased customer',phone=NULL,metadata='{}'::jsonb,
      status='erased',version=version+1,updated_at=now() WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
  }

  private identityHash(value: string): string {
    return createHmac('sha256', config().INTERNAL_SERVICE_TOKEN).update(value.trim().toLowerCase()).digest('hex');
  }

  private async getForUpdate(client: pg.PoolClient, requestId: string): Promise<ErasureRow | undefined> {
    const result = await client.query<ErasureRow>(
      `SELECT * FROM customers.erasure_requests WHERE id=$1 FOR UPDATE`, [requestId],
    );
    return result.rows[0];
  }
}
