import { Redis } from 'ioredis';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { config } from '../../../packages/config/src/index.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';

export type ErasureRequest = {
  id: string; merchant_id: string; customer_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed'; attempts: number;
  created_at: Date; updated_at: Date; completed_at: Date | null; last_error: string | null;
};

type ErasureTargets = { objectKeys: string[]; destinations: string[] };

export function erasureResponse(row: ErasureRequest): Record<string, unknown> {
  return { id: row.id, customerId: row.customer_id, status: row.status, attempts: row.attempts,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at, lastError: row.last_error };
}

export class ErasureService {
  async create(merchantId: string, customerId: string, key: string): Promise<ErasureRequest> {
    return await transaction(async (client) => {
      const existingKey = await client.query<ErasureRequest>(
        `SELECT * FROM operations.customer_erasure_requests WHERE merchant_id=$1 AND idempotency_key=$2 FOR UPDATE`, [merchantId, key],
      );
      if (existingKey.rows[0]) {
        if (existingKey.rows[0].customer_id !== customerId) throw Object.assign(new Error('idempotency_key_reused'), { statusCode: 409 });
        return existingKey.rows[0];
      }
      const existing = await client.query<ErasureRequest>(
        `SELECT * FROM operations.customer_erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`, [merchantId, customerId],
      );
      if (existing.rows[0]) return existing.rows[0];
      const customer = await client.query(`UPDATE customers.customers SET status='erasing',updated_at=now()
        WHERE merchant_id=$1 AND id=$2 AND status='active' RETURNING id`, [merchantId, customerId]);
      if (!customer.rowCount) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });
      const created = await client.query<ErasureRequest>(
        `INSERT INTO operations.customer_erasure_requests(merchant_id,customer_id,idempotency_key,status)
         VALUES($1,$2,$3,'pending') RETURNING *`, [merchantId, customerId, key],
      );
      return created.rows[0]!;
    });
  }

  async find(merchantId: string, id: string): Promise<ErasureRequest | undefined> {
    const result = await pool.query<ErasureRequest>(`SELECT * FROM operations.customer_erasure_requests WHERE merchant_id=$1 AND id=$2`, [merchantId, id]);
    return result.rows[0];
  }

  async processAvailable(): Promise<boolean> {
    const request = await transaction(async (client) => {
      const claimed = await client.query<ErasureRequest>(`UPDATE operations.customer_erasure_requests SET status='processing',attempts=attempts+1,updated_at=now(),last_error=NULL
        WHERE id=(SELECT id FROM operations.customer_erasure_requests
          WHERE status IN ('pending','failed') OR (status='processing' AND updated_at < now()-interval '5 minutes')
          ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`);
      return claimed.rows[0];
    });
    if (!request) return false;
    try {
      const targets = await this.targets(request);
      await this.purgeExternal(request, targets);
      await this.scrub(request);
    } catch (error) {
      await pool.query(`UPDATE operations.customer_erasure_requests SET status='failed',last_error=$2,updated_at=now() WHERE id=$1`,
        [request.id, stableError(error)]);
    }
    return true;
  }

  private async targets(request: ErasureRequest): Promise<ErasureTargets> {
    const result = await pool.query<{ object_key: string | null; destination: string | null }>(
      `SELECT object_key,NULL::text destination FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2
       UNION SELECT NULL,destination FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2
       UNION SELECT NULL,destination FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [request.merchant_id, request.customer_id],
    );
    return { objectKeys: result.rows.flatMap((row) => row.object_key ? [row.object_key] : []),
      destinations: [...new Set(result.rows.flatMap((row) => row.destination ? [row.destination] : []))] };
  }

  private async purgeExternal(request: ErasureRequest, targets: ErasureTargets): Promise<void> {
    await Promise.all(targets.objectKeys.map(async (key) => await objectStore.removeObject(DOCUMENT_BUCKET, key)));
    await Promise.all(targets.destinations.map(async (destination) => await deleteMailpitMessagesForRecipient(destination)));
    try {
      await searchClient.delete({ index: CUSTOMER_INDEX, id: `${request.merchant_id}:${request.customer_id}`, refresh: true });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
    const redis = new Redis(config().REDIS_URL);
    try { await redis.del(`merchant:${request.merchant_id}:customer:${request.customer_id}`, `merchant:${request.merchant_id}:customer:${request.customer_id}:activity`); }
    finally { await redis.quit(); }
  }

  private async scrub(request: ErasureRequest): Promise<void> {
    await transaction(async (client) => {
      const params = [request.merchant_id, request.customer_id];
      await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`UPDATE customers.support_messages SET author_id=NULL,body='[erased]',attachments='[]' WHERE merchant_id=$1 AND author_id=$2`, params);
      await client.query(`UPDATE customers.support_tickets SET subject='[erased]' WHERE merchant_id=$1 AND id IN (SELECT ticket_id FROM customers.support_participants WHERE customer_id=$2)`, params);
      await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$2`, params);
      await client.query(`UPDATE payments.payment_intents SET customer_snapshot='{}' WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`UPDATE payments.payment_attempts a SET request_payload='{}',response_payload=NULL,failure_message=NULL FROM payments.payment_intents p WHERE a.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`, params);
      await client.query(`UPDATE payments.refunds r SET customer_email=NULL FROM payments.payment_intents p WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`, params);
      await client.query(`UPDATE payments.invoices SET billing_snapshot='{}' WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, params);
      await client.query(`DELETE FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`UPDATE operations.email_deliveries SET destination='[erased]',subject='[erased]',text_body='[erased]',html_body='[erased]',status='cancelled',cancelled_at=now() WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`UPDATE operations.notifications SET destination='[erased]',payload='{}',status='cancelled' WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, params);
      await client.query(`DELETE FROM operations.jobs WHERE merchant_id=$1 AND payload->>'customerId'=$2`, params);
      await client.query(`DELETE FROM operations.outbox_events WHERE merchant_id=$1 AND (aggregate_id=$2::uuid OR payload->>'customerId'=$2)`, params);
      await client.query(`DELETE FROM operations.dead_letters WHERE payload->>'customerId'=$1`, [request.customer_id]);
      await client.query(`UPDATE platform.audit_logs SET target_id=NULL,metadata='{}' WHERE merchant_id=$1 AND target_id=$2`, params);
      await client.query(`UPDATE customers.customers SET external_reference='erased-' || id::text,email='erased-' || id::text || '@deleted.invalid',name='Erased customer',phone=NULL,metadata='{}',status='erased',updated_at=now() WHERE merchant_id=$1 AND id=$2`, params);
      await client.query(`UPDATE operations.customer_erasure_requests SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL WHERE id=$1`, [request.id]);
    });
  }
}

function stableError(error: unknown): string {
  return error instanceof Error && error.name === 'TimeoutError' ? 'external_timeout' : 'erasure_cleanup_failed';
}
