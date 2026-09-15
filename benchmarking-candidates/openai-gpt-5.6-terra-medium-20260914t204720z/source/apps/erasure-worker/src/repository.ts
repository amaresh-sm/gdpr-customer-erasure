import type { PoolClient } from 'pg';
import { pool, transaction } from '../../../packages/database/src/pool.js';

export type ErasureRequest = {
  id: string; customer_id: string; status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number; created_at: Date; updated_at: Date; completed_at: Date | null; last_error: string | null;
};

type Queryable = Pick<PoolClient, 'query'>;

export class ErasureRepository {
  async createOrResume(merchantId: string, customerId: string, key: string): Promise<ErasureRequest | undefined> {
    return await transaction(async (client) => {
      const idempotency = await client.query<{ customer_id: string; request_id: string }>(
        `SELECT customer_id,request_id FROM privacy.erasure_idempotency_keys WHERE merchant_id=$1 AND key=$2 FOR UPDATE`, [merchantId, key],
      );
      if (idempotency.rows[0] && idempotency.rows[0].customer_id !== customerId) {
        throw Object.assign(new Error('idempotency_key_reused'), { statusCode: 409 });
      }
      if (idempotency.rows[0]) return await this.findById(client, merchantId, idempotency.rows[0].request_id);

      const existing = await client.query<ErasureRequest>(
        `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`, [merchantId, customerId],
      );
      let request = existing.rows[0];
      if (!request) {
        const customer = await client.query(`SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`, [merchantId, customerId]);
        if (!customer.rowCount) return undefined;
        const created = await client.query<ErasureRequest>(
          `INSERT INTO privacy.erasure_requests(merchant_id,customer_id,status) VALUES($1,$2,'pending') RETURNING *`, [merchantId, customerId],
        );
        request = created.rows[0]!;
        await client.query(`UPDATE customers.customers SET status='erasing',updated_at=now() WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
        await client.query(`INSERT INTO operations.jobs(queue,job_type,merchant_id,payload,max_attempts) VALUES('privacy','erase_customer',$1,$2,8)`, [merchantId, { requestId: request.id, customerId }]);
      } else if (request.status === 'failed') {
        request = (await client.query<ErasureRequest>(`UPDATE privacy.erasure_requests SET status='pending',last_error=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [request.id])).rows[0]!;
        await client.query(
          `INSERT INTO operations.jobs(queue,job_type,merchant_id,payload,max_attempts)
           SELECT 'privacy','erase_customer',$1,$2,8 WHERE NOT EXISTS
           (SELECT 1 FROM operations.jobs WHERE queue='privacy' AND payload->>'requestId'=$3 AND status IN ('pending','retry','processing'))`,
          [merchantId, { requestId: request.id, customerId }, request.id],
        );
      }
      await client.query(`INSERT INTO privacy.erasure_idempotency_keys(merchant_id,key,customer_id,request_id) VALUES($1,$2,$3,$4)`, [merchantId, key, customerId, request.id]);
      return request;
    });
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequest | undefined> { return await this.findById(pool, merchantId, requestId); }

  async objectKeys(merchantId: string, customerId: string): Promise<string[]> {
    const result = await pool.query<{ object_key: string }>(`SELECT object_key FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    return result.rows.map((row) => row.object_key);
  }

  async begin(requestId: string, merchantId: string): Promise<ErasureRequest | undefined> {
    const result = await pool.query<ErasureRequest>(
      `UPDATE privacy.erasure_requests SET status='processing',attempts=attempts+1,updated_at=now()
       WHERE id=$1 AND merchant_id=$2 AND status IN ('pending','failed') RETURNING *`, [requestId, merchantId],
    );
    return result.rows[0];
  }

  async fail(requestId: string, merchantId: string): Promise<void> {
    await pool.query(`UPDATE privacy.erasure_requests SET status='failed',last_error='erasure_cleanup_failed',updated_at=now() WHERE id=$1 AND merchant_id=$2 AND status<>'completed'`, [requestId, merchantId]);
  }

  async eraseDatabase(merchantId: string, customerId: string, requestId: string): Promise<string[]> {
    return await transaction(async (client) => {
      const request = await this.findById(client, merchantId, requestId);
      if (!request || request.status === 'completed') return [];
      const objects = await client.query<{ object_key: string }>(`SELECT object_key FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      const replacementId = (await client.query<{ id: string }>('SELECT gen_random_uuid() id')).rows[0]!.id;
      await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.support_messages WHERE merchant_id=$1 AND author_id=$2`, [merchantId, customerId]);
      await client.query(
        `DELETE FROM customers.support_messages WHERE ticket_id IN (
           SELECT p.ticket_id FROM customers.support_participants p
           WHERE p.customer_id=$1 AND NOT EXISTS (
             SELECT 1 FROM customers.support_participants other
             WHERE other.ticket_id=p.ticket_id AND other.customer_id<>$1
           )
         )`, [customerId],
      );
      await client.query(
        `WITH removed AS (
           DELETE FROM customers.support_participants WHERE customer_id=$2 RETURNING ticket_id
         )
         DELETE FROM customers.support_tickets t WHERE merchant_id=$1 AND t.id IN (
           SELECT ticket_id FROM removed WHERE NOT EXISTS (
             SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=removed.ticket_id
           )
         )`, [merchantId, customerId],
      );
      await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.outbox_events WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2)`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.jobs WHERE merchant_id=$1 AND payload->>'customerId'=$2 AND queue<>'privacy'`, [merchantId, customerId]);
      await client.query(`DELETE FROM platform.audit_logs WHERE merchant_id=$1 AND target_id=$2`, [merchantId, customerId]);
      await client.query(`UPDATE payments.payment_intents SET customer_id=$3,customer_snapshot='{"status":"erased"}'::jsonb WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId, replacementId]);
      await client.query(`UPDATE payments.refunds r SET customer_email=NULL FROM payments.payment_intents p WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`, [merchantId, replacementId]);
      await client.query(`UPDATE payments.invoices SET customer_id=$3,billing_snapshot='{"status":"erased"}'::jsonb WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId, replacementId]);
      await client.query(`UPDATE operations.provider_webhooks SET payload='{}'::jsonb WHERE payload->>'customerId'=$1`, [customerId]);
      await client.query(`INSERT INTO privacy.erased_customers(merchant_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
      await client.query(`UPDATE privacy.erasure_requests SET status='completed',completed_at=now(),last_error=NULL,updated_at=now() WHERE id=$1 AND merchant_id=$2`, [requestId, merchantId]);
      return objects.rows.map((row) => row.object_key);
    });
  }

  private async findById(client: Queryable, merchantId: string, requestId: string): Promise<ErasureRequest | undefined> {
    const result = await client.query<ErasureRequest>(`SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND id=$2`, [merchantId, requestId]);
    return result.rows[0];
  }
}
