import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../../../packages/config/src/index.js';
import { pool, transaction, advisoryLock } from '../../../packages/database/src/pool.js';
import { claimJob, completeJob, failJob, recoverExpiredJobLeases, type ClaimedJob } from '../../../packages/operations/src/job-lifecycle.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';

const requestIdSchema = z.string().uuid();
const jobPayloadSchema = z.object({ requestId: z.string().uuid(), customerId: z.string().uuid().optional() });

type ErasureStatus = 'pending' | 'processing' | 'failed' | 'completed';
interface ErasureRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: ErasureStatus;
  attempts: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  last_error: string | null;
  object_keys: string[];
}

export interface ErasureResponse {
  id: string;
  customerId: string;
  status: ErasureStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

function response(row: ErasureRow): ErasureResponse {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

export class ErasureService {
  async start(merchantId: string, customerId: string, idempotencyKey: string): Promise<ErasureResponse> {
    return await transaction(async (client) => {
      await advisoryLock(client, `erasure-key:${merchantId}:${idempotencyKey}`);
      await advisoryLock(client, `erasure-customer:${merchantId}:${customerId}`);
      const requestHash = `${merchantId}:${customerId}`;
      const key = await client.query<{ request_id: string; request_hash: string }>(
        `SELECT request_id,request_hash FROM privacy.erasure_request_keys
         WHERE merchant_id=$1 AND idempotency_key=$2 FOR UPDATE`, [merchantId, idempotencyKey],
      );
      if (key.rows[0] && key.rows[0].request_hash !== requestHash) {
        throw Object.assign(new Error('idempotency_key_conflict'), { statusCode: 409 });
      }
      if (key.rows[0]) {
        const existing = await this.findById(client, merchantId, key.rows[0].request_id, true);
        if (!existing) throw new Error('erasure request is unavailable');
        await this.ensureRetryJob(client, existing);
        const refreshed = await this.findById(client, merchantId, existing.id, true);
        return response(refreshed ?? existing);
      }

      const existing = await client.query<ErasureRow>(
        `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`, [merchantId, customerId],
      );
      if (existing.rows[0]) {
        const request = existing.rows[0];
        await this.ensureRetryJob(client, request);
        await client.query(
          `INSERT INTO privacy.erasure_request_keys(merchant_id,idempotency_key,request_id,request_hash)
           VALUES($1,$2,$3,$4)`, [merchantId, idempotencyKey, request.id, requestHash],
        );
        const refreshed = await this.findById(client, merchantId, request.id, true);
        return response(refreshed ?? request);
      }

      const customer = await client.query<{ status: string }>(
        `SELECT status FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`, [merchantId, customerId],
      );
      if (!customer.rows[0]) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });

      let request: ErasureRow;
      if (existing.rows[0]) {
        request = existing.rows[0];
        await this.ensureRetryJob(client, request);
      } else {
        const inserted = await client.query<ErasureRow>(
          `INSERT INTO privacy.erasure_requests(merchant_id,customer_id,status)
           VALUES($1,$2,'pending') RETURNING *`, [merchantId, customerId],
        );
        request = inserted.rows[0]!;
        await client.query(
          `UPDATE customers.customers SET status='erasing',version=version+1,updated_at=now()
           WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId],
        );
        await this.enqueue(client, request);
      }
      await client.query(
        `INSERT INTO privacy.erasure_request_keys(merchant_id,idempotency_key,request_id,request_hash)
         VALUES($1,$2,$3,$4)`, [merchantId, idempotencyKey, request.id, requestHash],
      );
      return response(request);
    });
  }

  async find(merchantId: string, requestId: string): Promise<ErasureResponse | undefined> {
    requestIdSchema.parse(requestId);
    const result = await poolQuery<ErasureRow>(
      `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND id=$2`, [merchantId, requestId],
    );
    return result.rows[0] ? response(result.rows[0]) : undefined;
  }

  async process(job: ClaimedJob<{ requestId: string; customerId?: string }>): Promise<void> {
    const payload = jobPayloadSchema.parse(job.payload);
    const keys = await transaction(async (client) => await this.scrubDatabase(client, payload.requestId));
    await this.removeObjects(keys);
    await this.removeProjections(keys.merchantId, keys.customerId);
    await transaction(async (client) => {
      await client.query(
        `UPDATE privacy.erasure_requests SET status='completed',completed_at=COALESCE(completed_at,now()),
         updated_at=now(),last_error=NULL WHERE id=$1`, [payload.requestId],
      );
      await completeJob(client, job);
    });
  }

  async fail(job: ClaimedJob<{ requestId: string; customerId?: string }>): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `UPDATE privacy.erasure_requests SET status='failed',updated_at=now(),last_error='erasure_cleanup_failed'
         WHERE id=$1 AND status<>'completed'`, [job.payload.requestId],
      );
      await failJob(client, job, new Error('erasure_cleanup_failed'));
    });
  }

  async recover(): Promise<number> { return await recoverExpiredJobLeases('privacy'); }

  private async findById(client: pg.PoolClient, merchantId: string, requestId: string, lock: boolean): Promise<ErasureRow | undefined> {
    const result = await client.query<ErasureRow>(
      `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  private async enqueue(client: pg.PoolClient, request: ErasureRow): Promise<void> {
    await client.query(
      `INSERT INTO operations.jobs(queue,job_type,merchant_id,payload,max_attempts)
       VALUES('privacy','customer_erasure',$1,$2,8)`,
      [request.merchant_id, { requestId: request.id, customerId: request.customer_id }],
    );
  }

  private async ensureRetryJob(client: pg.PoolClient, request: ErasureRow): Promise<void> {
    if (request.status === 'completed') return;
    if (request.status === 'failed') {
      await client.query(
        `UPDATE privacy.erasure_requests SET status='pending',updated_at=now(),last_error=NULL WHERE id=$1`, [request.id],
      );
    }
    const pending = await client.query(
      `SELECT 1 FROM operations.jobs WHERE queue='privacy' AND payload->>'requestId'=$1
       AND status IN ('pending','retry','processing') LIMIT 1`, [request.id],
    );
    if (!pending.rowCount) await this.enqueue(client, { ...request, status: 'pending' });
  }

  private async scrubDatabase(client: pg.PoolClient, requestId: string): Promise<{ merchantId: string; customerId: string; objectKeys: string[] }> {
    const request = await client.query<ErasureRow>(
      `SELECT * FROM privacy.erasure_requests WHERE id=$1 FOR UPDATE`, [requestId],
    );
    const row = request.rows[0];
    if (!row) throw new Error('erasure_request_not_found');
    if (row.status === 'completed') return { merchantId: row.merchant_id, customerId: row.customer_id, objectKeys: [] };
    const docs = row.object_keys.length ? undefined : await client.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`,
      [row.merchant_id, row.customer_id],
    );
    await client.query(`DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id]);
    const imports = row.object_keys.length ? { rows: [] as { object_key: string }[] } : await client.query<{ object_key: string }>(
      `SELECT object_key FROM customers.customer_imports WHERE merchant_id=$1 AND customer_id=$2`,
      [row.merchant_id, row.customer_id],
    );
    const importKeys = imports.rows.map((item) => item.object_key);
    const objectKeys = row.object_keys.length
      ? row.object_keys
      : [...new Set([...(docs?.rows.map((item) => item.object_key) ?? []), ...importKeys])];
    await client.query(
      `UPDATE privacy.erasure_requests SET status='processing',attempts=attempts+1,updated_at=now(),last_error=NULL,object_keys=$2
       WHERE id=$1`, [requestId, JSON.stringify(objectKeys)],
    );
    await client.query(`DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id]);

    await client.query(
      `UPDATE payments.invoice_lines SET description='[redacted]'
       WHERE invoice_id IN (SELECT id FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2)`, [row.merchant_id, row.customer_id],
    );
    await client.query(
      `UPDATE payments.disputes SET reason='redacted',evidence='{}'
       WHERE merchant_id=$1 AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [row.merchant_id, row.customer_id],
    );
    await client.query(
      `UPDATE payments.invoices SET customer_id=NULL,billing_snapshot='{"redacted":true}',object_key=NULL
       WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id],
    );
    await client.query(`UPDATE payments.payment_attempts SET request_payload='{}',response_payload='{}',failure_message=NULL
      WHERE merchant_id=$1 AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [row.merchant_id, row.customer_id]);
    await client.query(`UPDATE payments.refunds SET customer_email=NULL,reason='redacted'
      WHERE merchant_id=$1 AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [row.merchant_id, row.customer_id]);
    await client.query(
      `UPDATE payments.payment_intents SET customer_id=NULL,customer_snapshot='{"redacted":true}',description=NULL,updated_at=now()
       WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id],
    );
    await client.query(`UPDATE provider_sandbox.refunds SET reason='redacted'
      WHERE merchant_id=$1 AND provider_payment_id IN
        (SELECT p.id FROM provider_sandbox.payment_intents p
         JOIN customers.provider_customer_mappings m ON m.provider_customer_id=p.provider_customer_id
         WHERE m.merchant_id=$1 AND m.customer_id=$2)`, [row.merchant_id, row.customer_id]);
    await client.query(`UPDATE provider_sandbox.payment_intents SET provider_customer_id=NULL,payment_method_id=NULL
      WHERE merchant_id=$1 AND provider_customer_id IN
        (SELECT provider_customer_id FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2)`, [row.merchant_id, row.customer_id]);
    await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, [row.merchant_id, row.customer_id]);
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id]);

    await client.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id]);
    await client.query(`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id]);
    await client.query(
      `UPDATE operations.analytics_events SET customer_id=NULL,anonymous_id=$3,email=NULL,properties='{}'
       WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id, `erased:${row.id}`],
    );
    await client.query(
      `UPDATE operations.outbox_events SET payload=payload-'customerId'-'customerEmail'-'email'-'name'-'phone'-'externalReference'-'customerSnapshot'-'metadata'
       WHERE merchant_id=$1 AND payload->>'customerId'=$2`, [row.merchant_id, row.customer_id],
    );
    await client.query(
      `DELETE FROM operations.outbox_events WHERE merchant_id=$1 AND
       (aggregate_id=$2 OR payload->>'customerId'=$2)`, [row.merchant_id, row.customer_id],
    );
    await client.query(
      `UPDATE operations.jobs SET payload=jsonb_build_object('requestId',$3::text),
       status=CASE WHEN status IN ('pending','retry') THEN 'completed' ELSE status END
       WHERE merchant_id=$1 AND payload->>'customerId'=$2`, [row.merchant_id, row.customer_id, row.id],
    );
    await client.query(`DELETE FROM platform.audit_logs WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`, [row.merchant_id, row.customer_id]);
    await client.query(`DELETE FROM customers.support_messages WHERE merchant_id=$1 AND author_id=$2`, [row.merchant_id, row.customer_id]);
    await client.query(`UPDATE customers.support_tickets SET subject='[redacted]' WHERE merchant_id=$1 AND id IN
      (SELECT ticket_id FROM customers.support_participants WHERE customer_id=$2)`, [row.merchant_id, row.customer_id]);
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [row.customer_id]);
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id]);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [row.merchant_id, row.customer_id]);
    await client.query(`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [row.merchant_id, row.customer_id]);

    return { merchantId: row.merchant_id, customerId: row.customer_id, objectKeys };
  }

  private async removeObjects(keys: { objectKeys: string[] }): Promise<void> {
    await ensureBucket();
    for (const key of keys.objectKeys) await objectStore.removeObject(DOCUMENT_BUCKET, key);
  }

  private async removeProjections(merchantId: string, customerId: string): Promise<void> {
    try { await searchClient.delete({ index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}` }); }
    catch (error) { if ((error as { meta?: { statusCode?: number } }).meta?.statusCode !== 404) throw error; }
    const redis = new Redis(config().REDIS_URL);
    try { await redis.del(`merchant:${merchantId}:customer:${customerId}`, `merchant:${merchantId}:customer:${customerId}:activity`); }
    finally { await redis.quit(); }
  }
}

async function poolQuery<T extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<pg.QueryResult<T>> {
  return await pool.query<T>(text, values);
}

export async function runErasureWorker(signal: AbortSignal): Promise<void> {
  const service = new ErasureService();
  const workerId = `privacy-worker-${randomUUID()}`;
  let lastRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastRecovery > 30_000) { await service.recover(); lastRecovery = Date.now(); }
    const job = await claimJob<{ requestId: string; customerId?: string }>('privacy', workerId);
    if (!job) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try { await service.process(job); }
    catch { await service.fail(job); }
  }
}
