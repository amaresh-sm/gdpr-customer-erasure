import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../../config/src/index.js';
import { advisoryLock, pool, transaction } from '../../database/src/pool.js';
import { addOutboxEvent } from '../../messaging/src/outbox.js';
import { logger } from '../../observability/src/logger.js';
import { CUSTOMER_INDEX, searchClient } from '../../search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../storage/src/minio.js';
import { EVENT_TYPES } from '../../contracts/src/events.js';

export type ErasureStatus = 'pending' | 'processing' | 'failed' | 'completed';
export interface ErasureRequest {
  id: string;
  customer_id: string;
  status: ErasureStatus;
  attempts: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  last_error: string | null;
}

export class ErasureConflictError extends Error {
  statusCode = 409;
  constructor() { super('idempotency_key_reused'); }
}

export class CustomerNotFoundError extends Error {
  statusCode = 404;
  constructor() { super('customer_not_found'); }
}

function hashIdempotencyKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function serializeErasureRequest(request: ErasureRequest): Record<string, unknown> {
  return {
    id: request.id,
    customerId: request.customer_id,
    status: request.status,
    attempts: request.attempts,
    createdAt: request.created_at.toISOString(),
    updatedAt: request.updated_at.toISOString(),
    completedAt: request.completed_at?.toISOString() ?? null,
    lastError: request.last_error,
  };
}

export async function isCustomerErased(merchantId: string, customerId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM operations.customer_erasure_tombstones WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

export class CustomerErasureService {
  async createOrResume(merchantId: string, customerId: string, idempotencyKey: string): Promise<ErasureRequest> {
    return await transaction(async (client) => {
      const keyHash = hashIdempotencyKey(idempotencyKey);
      await advisoryLock(client, `erasure-key:${merchantId}:${keyHash}`);
      await advisoryLock(client, `erasure-customer:${merchantId}:${customerId}`);
      const keyed = await client.query<ErasureRequest>(
        `SELECT r.id,r.customer_id,r.status,r.attempts,r.created_at,r.updated_at,r.completed_at,r.last_error
         FROM operations.customer_erasure_idempotency_keys k
         JOIN operations.customer_erasure_requests r ON r.id=k.request_id
         WHERE k.merchant_id=$1 AND k.idempotency_key_hash=$2 FOR UPDATE`,
        [merchantId, keyHash],
      );
      if (keyed.rows[0]) {
        if (keyed.rows[0].customer_id !== customerId) throw new ErasureConflictError();
        if (keyed.rows[0].status !== 'failed') return keyed.rows[0];
        const resumed = await client.query<ErasureRequest>(
          `UPDATE operations.customer_erasure_requests SET status='pending',updated_at=now(),last_error=NULL
           WHERE id=$1 RETURNING id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`,
          [keyed.rows[0].id],
        );
        return resumed.rows[0]!;
      }

      const existing = await client.query<ErasureRequest>(
        `SELECT id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error
         FROM operations.customer_erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
        [merchantId, customerId],
      );
      if (existing.rows[0]) {
        const mapped = await client.query(
          `INSERT INTO operations.customer_erasure_idempotency_keys(merchant_id,idempotency_key_hash,customer_id,request_id)
           VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING request_id`,
          [merchantId, keyHash, customerId, existing.rows[0].id],
        );
        if (!mapped.rowCount) throw new ErasureConflictError();
        if (existing.rows[0].status !== 'failed') return existing.rows[0];
        const resumed = await client.query<ErasureRequest>(
          `UPDATE operations.customer_erasure_requests SET status='pending',updated_at=now(),last_error=NULL
           WHERE id=$1 RETURNING id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`,
          [existing.rows[0].id],
        );
        return resumed.rows[0]!;
      }

      const customer = await client.query(
        `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2 AND status='active' FOR UPDATE`,
        [merchantId, customerId],
      );
      if (!customer.rowCount) throw new CustomerNotFoundError();

      const created = await client.query<ErasureRequest>(
        `INSERT INTO operations.customer_erasure_requests(merchant_id,customer_id,idempotency_key_hash)
         VALUES($1,$2,$3)
         RETURNING id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`,
        [merchantId, customerId, keyHash],
      );
      const request = created.rows[0]!;
      await client.query(
        `INSERT INTO operations.customer_erasure_idempotency_keys(merchant_id,idempotency_key_hash,customer_id,request_id)
         VALUES($1,$2,$3,$4)`,
        [merchantId, keyHash, customerId, request.id],
      );
      await client.query(`UPDATE customers.customers SET status='erasure_pending',updated_at=now() WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
      await client.query(
        `INSERT INTO operations.customer_erasure_tombstones(merchant_id,customer_id,request_id) VALUES($1,$2,$3)`,
        [merchantId, customerId, request.id],
      );
      return request;
    });
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequest | undefined> {
    const result = await pool.query<ErasureRequest>(
      `SELECT id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error
       FROM operations.customer_erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }
}

type ClaimedErasure = ErasureRequest & { merchant_id: string };

export class CustomerErasureWorker {
  async processOne(): Promise<boolean> {
    const request = await transaction(async (client) => {
      const claimed = await client.query<ClaimedErasure>(
        `UPDATE operations.customer_erasure_requests SET status='processing',attempts=attempts+1,updated_at=now(),last_error=NULL
         WHERE id=(SELECT id FROM operations.customer_erasure_requests WHERE status='pending'
                   ORDER BY updated_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id,merchant_id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`,
      );
      return claimed.rows[0];
    });
    if (!request) return false;

    try {
      await this.erase(request);
      await pool.query(
        `UPDATE operations.customer_erasure_requests
         SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL WHERE id=$1`,
        [request.id],
      );
    } catch (error) {
      const lastError = error instanceof ErasureStepError ? error.code : 'database_cleanup_failed';
      logger.error({ error, requestId: request.id }, 'customer erasure failed');
      await pool.query(
        `UPDATE operations.customer_erasure_requests SET status='failed',updated_at=now(),last_error=$2 WHERE id=$1`,
        [request.id, lastError],
      );
    }
    return true;
  }

  private async erase(request: ClaimedErasure): Promise<void> {
    const documentKeys = await this.documentKeys(request.merchant_id, request.customer_id);
    await this.removeObjects(documentKeys);
    await this.purgeSearchAndCache(request.merchant_id, request.customer_id);
    await transaction(async (client) => {
      const { merchant_id: merchantId, customer_id: customerId } = request;
      await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, [merchantId, customerId]);
      await client.query(`UPDATE customers.support_messages SET author_id=NULL,body='[redacted]',attachments='[]'::jsonb WHERE merchant_id=$1 AND author_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);

      await client.query(`DELETE FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`UPDATE operations.jobs SET status='cancelled',payload='{}'::jsonb,last_error='customer_erased' WHERE merchant_id=$1 AND payload->>'customerId'=$2 AND status IN ('pending','retry','processing')`, [merchantId, customerId]);
      await client.query(`UPDATE operations.dead_letters SET payload='{}'::jsonb WHERE payload->>'customerId'=$1`, [customerId]);
      await client.query(`UPDATE operations.outbox_events SET payload='{}'::jsonb WHERE merchant_id=$1 AND (aggregate_id=$2::uuid OR payload->>'customerId'=$2)`, [merchantId, customerId]);
      await client.query(`DELETE FROM platform.audit_logs WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`, [merchantId, customerId]);

      await client.query(`UPDATE payments.refunds SET customer_email=NULL WHERE merchant_id=$1 AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [merchantId, customerId]);
      await client.query(`UPDATE payments.payment_attempts SET request_payload=request_payload-'customerId'-'paymentMethodId',response_payload='{}'::jsonb WHERE merchant_id=$1 AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [merchantId, customerId]);
      await client.query(`UPDATE payments.invoices SET customer_id=NULL,billing_snapshot='{}'::jsonb,object_key=NULL WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`UPDATE provider_sandbox.payment_intents SET provider_customer_id=NULL,payment_method_id=NULL WHERE merchant_id=$1 AND payment_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [merchantId, customerId]);
      await client.query(`UPDATE payments.payment_intents SET customer_id=NULL,payment_method_id=NULL,customer_snapshot='{}'::jsonb WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
      await addOutboxEvent(client, {
        eventType: EVENT_TYPES.CUSTOMER_ERASED, aggregateType: 'customer', aggregateId: customerId,
        merchantId, correlationId: randomUUID(), payload: { customerId, erasureRequestId: request.id },
      });
    });
  }

  private async documentKeys(merchantId: string, customerId: string): Promise<string[]> {
    const result = await pool.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2
       UNION SELECT object_key FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2 AND object_key IS NOT NULL`,
      [merchantId, customerId],
    );
    return result.rows.map((row) => row.object_key);
  }

  private async removeObjects(keys: string[]): Promise<void> {
    try {
      for (const key of keys) await objectStore.removeObject(DOCUMENT_BUCKET, key);
    } catch (error) {
      throw new ErasureStepError('storage_cleanup_failed', error);
    }
  }

  private async purgeSearchAndCache(merchantId: string, customerId: string): Promise<void> {
    const redis = new Redis(config().REDIS_URL);
    try {
      await redis.del(`merchant:${merchantId}:customer:${customerId}`, `merchant:${merchantId}:customer:${customerId}:activity`);
      try {
        await searchClient.delete({ index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}`, refresh: true });
      } catch (error) {
        const status = (error as { meta?: { statusCode?: number } }).meta?.statusCode;
        if (status !== 404) throw error;
      }
    } catch (error) {
      throw new ErasureStepError('search_cleanup_failed', error);
    } finally {
      await redis.quit().catch(() => undefined);
    }
  }
}

class ErasureStepError extends Error {
  constructor(readonly code: 'storage_cleanup_failed' | 'search_cleanup_failed', cause: unknown) {
    super(code, { cause });
  }
}

export function startCustomerErasureWorker(signal: AbortSignal): void {
  const worker = new CustomerErasureWorker();
  void (async () => {
    while (!signal.aborted) {
      try {
        if (!await worker.processOne()) await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (error) {
        logger.error({ error }, 'customer erasure worker crashed');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  })();
}
