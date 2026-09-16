import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { PoolClient } from 'pg';
import { config } from '../../../packages/config/src/index.js';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { logger } from '../../../packages/observability/src/logger.js';

export type ErasureRequest = {
  id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  last_error: string | null;
};

type ClaimedRequest = ErasureRequest & { merchant_id: string };

export function erasureResponse(row: ErasureRequest): Record<string, unknown> {
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
  async request(merchantId: string, customerId: string, idempotencyKey: string): Promise<ErasureRequest | undefined> {
    return await transaction(async (client) => {
      const byKey = await client.query<ErasureRequest>(
        `SELECT id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error
         FROM operations.customer_erasure_requests
         WHERE merchant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [merchantId, idempotencyKey],
      );
      const existingForKey = byKey.rows[0];
      if (existingForKey) {
        if (existingForKey.customer_id !== customerId) {
          throw Object.assign(new Error('idempotency_key_reused_for_different_customer'), { statusCode: 409 });
        }
        return await this.resume(client, existingForKey);
      }

      const existing = await client.query<ErasureRequest>(
        `SELECT id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error
         FROM operations.customer_erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
        [merchantId, customerId],
      );
      if (existing.rows[0]) return await this.resume(client, existing.rows[0]);

      const customer = await client.query(
        `UPDATE customers.customers SET status='erasing',updated_at=now()
         WHERE merchant_id=$1 AND id=$2 AND status='active' RETURNING id`,
        [merchantId, customerId],
      );
      if (!customer.rowCount) return undefined;
      const created = await client.query<ErasureRequest>(
        `INSERT INTO operations.customer_erasure_requests(merchant_id,customer_id,idempotency_key)
         VALUES($1,$2,$3)
         RETURNING id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`,
        [merchantId, customerId, idempotencyKey],
      );
      return created.rows[0]!;
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

  private async resume(client: PoolClient, request: ErasureRequest): Promise<ErasureRequest> {
    if (request.status !== 'failed') return request;
    const result = await client.query<ErasureRequest>(
      `UPDATE operations.customer_erasure_requests
       SET status='pending',last_error=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1
       RETURNING id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`,
      [request.id],
    );
    return result.rows[0]!;
  }
}

export function startErasureWorker(signal: AbortSignal): void {
  const worker = new ErasureWorker(`customer-erasure-${randomUUID()}`);
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      let processed = !signal.aborted && await worker.processOne();
      while (!signal.aborted && processed) processed = await worker.processOne();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void run(); }, 250);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  void run();
}

class ErasureWorker {
  private readonly redis = new Redis(config().REDIS_URL);

  constructor(private readonly workerId: string) {}

  async processOne(): Promise<boolean> {
    const request = await this.claim();
    if (!request) return false;
    try {
      const identity = await this.identity(request);
      await this.eraseExternalCopies(request, identity);
      await transaction(async (client) => this.eraseDatabaseCopies(client, request));
    } catch (error) {
      const errorCode = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      logger.error({ requestId: request.id, errorType: error instanceof Error ? error.name : typeof error, errorCode }, 'customer erasure cleanup failed');
      await pool.query(
        `UPDATE operations.customer_erasure_requests
         SET status='failed',last_error='erasure_cleanup_failed',lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND locked_by=$2`,
        [request.id, this.workerId],
      );
    }
    return true;
  }

  private async claim(): Promise<ClaimedRequest | undefined> {
    return await transaction(async (client) => {
      const result = await client.query<ClaimedRequest>(
        `UPDATE operations.customer_erasure_requests
         SET status='processing',attempts=attempts+1,locked_by=$1,
             lease_expires_at=now()+interval '5 minutes',updated_at=now()
         WHERE id=(SELECT id FROM operations.customer_erasure_requests
           WHERE status='pending' OR (status='processing' AND lease_expires_at<now())
              OR (status='failed' AND updated_at<now()-interval '5 seconds')
           ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id,merchant_id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`,
        [this.workerId],
      );
      return result.rows[0];
    });
  }

  private async identity(request: ClaimedRequest): Promise<{ email: string; name: string; phone: string | null; external_reference: string } | undefined> {
    const result = await pool.query<{ email: string; name: string; phone: string | null; external_reference: string }>(
      `SELECT email,name,phone,external_reference FROM customers.customers
       WHERE merchant_id=$1 AND id=$2 AND status='erasing'`,
      [request.merchant_id, request.customer_id],
    );
    return result.rows[0];
  }

  private async eraseExternalCopies(
    request: ClaimedRequest,
    identity: { email: string; name: string; phone: string | null; external_reference: string } | undefined,
  ): Promise<void> {
    const objects = await pool.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2
       UNION
       SELECT object_key FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2 AND object_key IS NOT NULL`,
      [request.merchant_id, request.customer_id],
    );
    for (const { object_key } of objects.rows) await objectStore.removeObject(DOCUMENT_BUCKET, object_key);
    if (identity) {
      const imports = await pool.query<{ object_key: string }>(
        `SELECT i.object_key FROM customers.customer_imports i
         WHERE i.merchant_id=$1 AND EXISTS(
           SELECT 1 FROM operations.document_manifests d
           WHERE d.merchant_id=i.merchant_id AND d.object_key=i.object_key AND d.document_type='customer_import')`,
        [request.merchant_id],
      );
      for (const artifact of imports.rows) await this.redactImport(artifact.object_key, identity);
    }
    await Promise.all([
      this.redis.del(`merchant:${request.merchant_id}:customer:${request.customer_id}`),
      this.redis.del(`merchant:${request.merchant_id}:customer:${request.customer_id}:activity`),
      searchClient.delete({ index: CUSTOMER_INDEX, id: `${request.merchant_id}:${request.customer_id}` }).catch(() => undefined),
    ]);
  }

  private async redactImport(
    objectKey: string,
    identity: { email: string; name: string; phone: string | null; external_reference: string },
  ): Promise<void> {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const personalValues = new Set([identity.email, identity.name, identity.external_reference, identity.phone].filter(Boolean));
    const redact = (value: unknown): unknown => {
      if (typeof value === 'string') return personalValues.has(value) ? '[deleted]' : value;
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)]));
      }
      return value;
    };
    const redacted = JSON.stringify(redact(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    await objectStore.putObject(DOCUMENT_BUCKET, objectKey, redacted, Buffer.byteLength(redacted), { 'Content-Type': 'application/json' });
  }

  private async eraseDatabaseCopies(client: PoolClient, request: ClaimedRequest): Promise<void> {
    const values = [request.merchant_id, request.customer_id];
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, values);
    await client.query(`UPDATE customers.support_tickets t SET subject='[deleted]'
                        FROM customers.support_participants p WHERE p.ticket_id=t.id AND p.customer_id=$1`,
      [request.customer_id]);
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [request.customer_id]);
    await client.query(`UPDATE customers.support_messages SET author_id=NULL,body='[deleted]',attachments='[]'::jsonb
                        WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`, values);
    await client.query(`UPDATE payments.payment_attempts a SET request_payload='{}'::jsonb,response_payload='{}'::jsonb
                        FROM payments.payment_intents p WHERE a.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`, values);
    await client.query(`UPDATE payments.refunds r SET customer_email=NULL FROM payments.payment_intents p
                        WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`, values);
    await client.query(`UPDATE payments.payment_intents SET customer_id=NULL,customer_snapshot='{}'::jsonb
                        WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`UPDATE payments.invoices SET customer_id=NULL,billing_snapshot='{}'::jsonb,object_key=NULL
                        WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`UPDATE operations.analytics_events SET customer_id=NULL,anonymous_id=NULL,email=NULL,properties='{}'::jsonb
                        WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`UPDATE operations.email_deliveries SET destination='erased@invalid',subject='',text_body='',html_body='',
                        status=CASE WHEN status IN ('pending','processing','failed') THEN 'cancelled' ELSE status END,
                        cancelled_at=CASE WHEN status IN ('pending','processing','failed') THEN now() ELSE cancelled_at END
                        WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`UPDATE operations.notifications SET destination='erased@invalid',payload='{}'::jsonb
                        WHERE merchant_id=$1 AND customer_id=$2`, values);
    await client.query(`UPDATE operations.jobs SET status='cancelled',payload='{}'::jsonb
                        WHERE merchant_id=$1 AND payload->>'customerId'=$2::text`, values);
    await client.query(`DELETE FROM operations.outbox_events WHERE merchant_id=$1 AND payload->>'customerId'=$2::text`, values);
    await client.query(`DELETE FROM operations.dead_letters
                        WHERE payload->>'merchantId'=$1::text AND payload->>'customerId'=$2::text`, values);
    await client.query(`UPDATE platform.audit_logs SET target_id=NULL,metadata='{}'::jsonb
                        WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`, values);
    await client.query(`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2 AND status='erasing'`, values);
    await client.query(
      `UPDATE operations.customer_erasure_requests
       SET status='completed',completed_at=now(),last_error=NULL,locked_by=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND locked_by=$2`,
      [request.id, this.workerId],
    );
  }
}
