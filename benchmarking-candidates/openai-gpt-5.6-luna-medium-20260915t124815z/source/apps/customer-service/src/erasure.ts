import type pg from 'pg';
import { advisoryLock, pool, transaction } from '../../../packages/database/src/pool.js';
import { objectStore, DOCUMENT_BUCKET } from '../../../packages/storage/src/minio.js';

export type ErasureStatus = 'pending' | 'processing' | 'failed' | 'completed';
export interface ErasureRequest {
  id: string; customerId: string; status: ErasureStatus; attempts: number;
  createdAt: string; updatedAt: string; completedAt: string | null; lastError: string | null;
}
type ErasureRow = { id: string; customer_id: string; status: ErasureStatus; attempts: number; created_at: Date; updated_at: Date; completed_at: Date | null; last_error: string | null };

function present(row: ErasureRow): ErasureRequest {
  return { id: row.id, customerId: row.customer_id, status: row.status, attempts: row.attempts,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null, lastError: row.last_error };
}

export class ErasureService {
  async request(merchantId: string, customerId: string, key: string): Promise<ErasureRequest> {
    return transaction(async (client) => {
      const existing = await client.query<ErasureRow>(
        `SELECT id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error
         FROM customers.erasure_requests WHERE merchant_id=$1 AND (customer_id=$2 OR idempotency_key=$3) FOR UPDATE`, [merchantId, customerId, key]);
      const row = existing.rows[0];
      if (row && row.customer_id !== customerId) throw Object.assign(new Error('idempotency key belongs to another customer'), { statusCode: 409 });
      if (row) return present(row);
      const customer = await client.query(`SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`, [merchantId, customerId]);
      if (!customer.rowCount) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
      const created = await client.query<ErasureRow>(
        `INSERT INTO customers.erasure_requests(merchant_id,customer_id,idempotency_key) VALUES($1,$2,$3)
         RETURNING id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`, [merchantId, customerId, key]);
      await client.query(`UPDATE customers.customers SET status='erasing',updated_at=now() WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
      return present(created.rows[0]!);
    });
  }

  async get(merchantId: string, id: string): Promise<ErasureRequest | undefined> {
    const result = await pool.query<ErasureRow>(`SELECT id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`, [merchantId, id]);
    return result.rows[0] ? present(result.rows[0]) : undefined;
  }

  async processOne(): Promise<boolean> {
    const job = await transaction(async (client) => {
      const result = await client.query<{ id: string; merchant_id: string; customer_id: string }>(
        `UPDATE customers.erasure_requests SET status='processing',attempts=attempts+1,updated_at=now()
         WHERE id=(SELECT id FROM customers.erasure_requests
           WHERE status IN ('pending','failed') OR (status='processing' AND updated_at < now() - interval '5 minutes')
           ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id,merchant_id,customer_id`);
      return result.rows[0];
    });
    if (!job) return false;
    try {
      await this.erase(job.merchant_id, job.customer_id);
      await pool.query(`UPDATE customers.erasure_requests SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL WHERE id=$1`, [job.id]);
    } catch (error) {
      const code = error instanceof Error && error.message === 'customer_not_found' ? 'customer_not_found' : 'cleanup_failed';
      await pool.query(`UPDATE customers.erasure_requests SET status='failed',last_error=$2,updated_at=now() WHERE id=$1`, [job.id, code]);
    }
    return true;
  }

  private async erase(merchantId: string, customerId: string): Promise<void> {
    await transaction(async (client) => {
      await advisoryLock(client, `${merchantId}:${customerId}`);
      const customer = await client.query(`SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`, [merchantId, customerId]);
      if (!customer.rowCount) {
        const tombstone = await client.query(`SELECT 1 FROM customers.erased_customers WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
        if (tombstone.rowCount) return [] as string[];
        throw new Error('customer_not_found');
      }
      await client.query(`INSERT INTO customers.erased_customers(merchant_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`UPDATE provider_sandbox.payment_intents SET provider_customer_id=NULL WHERE provider_customer_id IN (SELECT provider_customer_id FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2)`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.support_messages WHERE merchant_id=$1 AND author_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);
      await client.query(`UPDATE payments.payment_intents SET customer_id=NULL,customer_snapshot='{}',description=NULL WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`UPDATE payments.invoices SET customer_id=NULL,billing_snapshot='{}',object_key=NULL WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`UPDATE payments.refunds SET customer_email=NULL WHERE merchant_id=$1 AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id IS NULL)`, [merchantId]);
      await client.query(`UPDATE payments.payment_attempts SET request_payload='{}',response_payload='{}',failure_message=NULL WHERE merchant_id=$1 AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id IS NULL)`, [merchantId, customerId]);
      await client.query(`UPDATE operations.analytics_events SET customer_id=NULL,email=NULL,properties='{}' WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      const docs = await client.query<{ object_key: string }>(`SELECT object_key FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      for (const doc of docs.rows) await objectStore.removeObject(DOCUMENT_BUCKET, doc.object_key);
      await client.query(`DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
      await client.query(`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
    });
  }
}

export function startErasureWorker(signal: AbortSignal): void {
  const service = new ErasureService();
  const run = async (): Promise<void> => {
    while (!signal.aborted) { if (!await service.processOne()) await new Promise((resolve) => setTimeout(resolve, 250)); }
  };
  void run();
}

export async function isErased(client: pg.PoolClient, merchantId: string, customerId: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM customers.erased_customers WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  return Boolean(result.rowCount);
}
