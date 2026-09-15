import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../../../packages/config/src/index.js';
import { transaction, pool, advisoryLock } from '../../../packages/database/src/pool.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';

type ErasureStatus = 'pending' | 'processing' | 'failed' | 'completed';

type ErasureRow = {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: ErasureStatus;
  attempts: number;
  last_error: string | null;
  object_keys: string[];
  scrubbed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type ErasureResponse = {
  id: string;
  customerId: string;
  status: ErasureStatus;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  lastError: string | null;
};

class ErasureFailure extends Error {
  constructor(readonly code: 'deletion_failed' | 'object_cleanup_failed' | 'search_cleanup_failed' | 'cache_cleanup_failed') {
    super(code);
  }
}

function response(row: ErasureRow): ErasureResponse {
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
  async create(merchantId: string, customerId: string, idempotencyKey: string): Promise<ErasureResponse> {
    const idempotencyKeyHash = createHash('sha256').update(idempotencyKey).digest('hex');
    return await transaction(async (client) => {
      const byKey = await client.query<ErasureRow>(
        `SELECT * FROM operations.erasure_requests WHERE merchant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [merchantId, idempotencyKeyHash],
      );
      if (byKey.rows[0]) {
        if (byKey.rows[0].customer_id !== customerId) {
          throw Object.assign(new Error('idempotency key belongs to another customer'), { statusCode: 409 });
        }
        return response(byKey.rows[0]);
      }

      const existing = await client.query<ErasureRow>(
        `SELECT * FROM operations.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
        [merchantId, customerId],
      );
      if (existing.rows[0]) return response(existing.rows[0]);

      const customer = await client.query<{ id: string; status: string }>(
        `SELECT id,status FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
        [merchantId, customerId],
      );
      if (!customer.rows[0]) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });

      const inserted = await client.query<ErasureRow>(
        `INSERT INTO operations.erasure_requests(merchant_id,customer_id,idempotency_key,status)
         VALUES($1,$2,$3,'pending') RETURNING *`,
        [merchantId, customerId, idempotencyKeyHash],
      );
      await client.query(
        `UPDATE customers.customers SET status='erasing',version=version+1,updated_at=now()
         WHERE merchant_id=$1 AND id=$2`,
        [merchantId, customerId],
      );
      return response(inserted.rows[0]!);
    });
  }

  async get(merchantId: string, requestId: string): Promise<ErasureResponse | undefined> {
    const result = await pool.query<ErasureRow>(
      `SELECT * FROM operations.erasure_requests WHERE merchant_id=$1 AND id=$2`, [merchantId, requestId],
    );
    return result.rows[0] ? response(result.rows[0]) : undefined;
  }

  async runOnce(workerId: string): Promise<boolean> {
    const request = await this.claim(workerId);
    if (!request) return false;
    try {
      const objectKeys = await this.scrub(request);
      for (const objectKey of objectKeys) {
        try {
          await objectStore.removeObject(DOCUMENT_BUCKET, objectKey);
        } catch {
          throw new ErasureFailure('object_cleanup_failed');
        }
      }
      try {
        await this.removeSearchAndCache(request);
      } catch (error) {
        if (error instanceof ErasureFailure) throw error;
        throw new ErasureFailure('search_cleanup_failed');
      }
      await transaction(async (client) => {
        await client.query(
          `UPDATE operations.erasure_requests
           SET status='completed',completed_at=COALESCE(completed_at,now()),updated_at=now(),
               lease_expires_at=NULL,last_error=NULL
           WHERE id=$1 AND merchant_id=$2`, [request.id, request.merchant_id],
        );
      });
    } catch (error) {
      const code = error instanceof ErasureFailure ? error.code : 'deletion_failed';
      await pool.query(
        `UPDATE operations.erasure_requests
         SET status='failed',last_error=$3,updated_at=now(),lease_expires_at=NULL
         WHERE id=$1 AND merchant_id=$2 AND status='processing'`,
        [request.id, request.merchant_id, code],
      );
    }
    return true;
  }

  async run(signal: AbortSignal, workerId = `erasure-worker-${randomUUID()}`): Promise<void> {
    while (!signal.aborted) {
      try {
        if (!await this.runOnce(workerId)) await new Promise((resolve) => setTimeout(resolve, 250));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private async claim(_workerId: string): Promise<ErasureRow | undefined> {
    return await transaction(async (client) => {
      const result = await client.query<ErasureRow>(
        `UPDATE operations.erasure_requests
         SET status='processing',attempts=attempts+1,updated_at=now(),lease_expires_at=now()+interval '60 seconds'
         WHERE id=(SELECT id FROM operations.erasure_requests
           WHERE status IN ('pending','failed') OR (status='processing' AND lease_expires_at < now())
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING *`,
      );
      if (!result.rows[0]) return undefined;
      await client.query(
        `UPDATE operations.erasure_requests SET last_error=NULL WHERE id=$1`, [result.rows[0].id],
      );
      return result.rows[0];
    });
  }

  private async scrub(request: ErasureRow): Promise<string[]> {
    return await transaction(async (client) => {
      await advisoryLock(client, request.customer_id);
      const current = await client.query<{ object_keys: string[]; scrubbed_at: Date | null }>(
        `SELECT object_keys,scrubbed_at FROM operations.erasure_requests WHERE id=$1 FOR UPDATE`, [request.id],
      );
      if (!current.rows[0]) throw new ErasureFailure('deletion_failed');
      const objectKeys = [...(current.rows[0].object_keys ?? [])];
      if (!current.rows[0].scrubbed_at) {
        const documents = await client.query<{ object_key: string }>(
          `SELECT object_key FROM operations.document_manifests
           WHERE merchant_id=$1 AND customer_id=$2 AND object_key IS NOT NULL`,
          [request.merchant_id, request.customer_id],
        );
        const imports = await client.query<{ object_key: string }>(
          `SELECT object_key FROM customers.customer_imports
           WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
        );
        objectKeys.push(...documents.rows.map((row) => row.object_key), ...imports.rows.map((row) => row.object_key));
      }

      await client.query(
        `DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
      );
      await client.query(
        `UPDATE provider_sandbox.payment_intents SET provider_customer_id=NULL
         WHERE merchant_id=$1 AND provider_customer_id IN
           (SELECT id FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2)`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`,
        [request.merchant_id, request.customer_id],
      );

      const tickets = await client.query<{ id: string }>(
        `SELECT ticket_id id FROM customers.support_participants WHERE customer_id=$1`, [request.customer_id],
      );
      await client.query(
        `DELETE FROM customers.support_messages WHERE merchant_id=$1 AND author_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM customers.support_participants WHERE customer_id=$1`, [request.customer_id],
      );
      if (tickets.rows.length) {
        const ticketIds = tickets.rows.map((ticket) => ticket.id);
        await client.query(
          `DELETE FROM customers.support_messages WHERE merchant_id=$1 AND ticket_id=ANY($2::uuid[])
           AND NOT EXISTS (SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=customers.support_messages.ticket_id)`,
          [request.merchant_id, ticketIds],
        );
        await client.query(
          `DELETE FROM customers.support_tickets t WHERE merchant_id=$1 AND id=ANY($2::uuid[])
           AND NOT EXISTS (SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id)`,
          [request.merchant_id, ticketIds],
        );
      }

      await client.query(
        `UPDATE payments.refunds r SET customer_email=NULL
         FROM payments.payment_intents p
         WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `UPDATE payments.payment_attempts a SET request_payload='{}'::jsonb,response_payload=NULL,failure_message=NULL
         FROM payments.payment_intents p
         WHERE a.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `UPDATE payments.disputes d SET evidence='{}'::jsonb
         FROM payments.payment_intents p
         WHERE d.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `UPDATE payments.payment_intents SET customer_id=NULL,payment_method_id=NULL,description=NULL,customer_snapshot='{}'::jsonb
         WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
      );
      await client.query(
        `UPDATE payments.invoices SET customer_id=NULL,billing_snapshot='{}'::jsonb,object_key=NULL
         WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND customer_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM operations.outbox_events WHERE merchant_id=$1
         AND (aggregate_id=$2 OR payload->>'customerId'=$2 OR payload->>'customerEmail' IN
              (SELECT email FROM customers.customers WHERE merchant_id=$1 AND id=$2))`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `UPDATE operations.jobs SET payload=payload-'customerId'-'customerEmail'-'customerSnapshot'
         WHERE merchant_id=$1 AND payload->>'customerId'=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `UPDATE operations.idempotency_keys
         SET response_body=response_body-'customerId'-'customerEmail'-'customerSnapshot'
         WHERE merchant_id=$1 AND response_body->>'customerId'=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `UPDATE operations.dead_letters
         SET payload=payload-'customerId'-'customerEmail'-'customerSnapshot'
         WHERE payload->>'customerId'=$1`, [request.customer_id],
      );

      await client.query(
        `DELETE FROM platform.audit_logs WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `UPDATE operations.erasure_requests
         SET object_keys=$2,scrubbed_at=COALESCE(scrubbed_at,now()),updated_at=now()
         WHERE id=$1`, [request.id, [...new Set(objectKeys)]],
      );
      return [...new Set(objectKeys)];
    });
  }

  private async removeSearchAndCache(request: ErasureRow): Promise<void> {
    try {
      await searchClient.delete({ index: CUSTOMER_INDEX, id: `${request.merchant_id}:${request.customer_id}` });
    } catch (error) {
      const statusCode = (error as { meta?: { statusCode?: number } }).meta?.statusCode;
      if (statusCode !== 404) throw new ErasureFailure('search_cleanup_failed');
    }
    const redis = new Redis(config().REDIS_URL);
    try {
      await redis.del(
        `merchant:${request.merchant_id}:customer:${request.customer_id}`,
        `merchant:${request.merchant_id}:customer:${request.customer_id}:activity`,
      );
    } catch {
      throw new ErasureFailure('cache_cleanup_failed');
    } finally {
      await redis.quit();
    }
  }
}
