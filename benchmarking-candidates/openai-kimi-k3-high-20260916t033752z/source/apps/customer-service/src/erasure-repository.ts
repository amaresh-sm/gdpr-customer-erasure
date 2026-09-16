import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import type { ErasureRequestRecord } from '../../../packages/privacy/src/redact.js';

export interface ErasureKeyRow {
  customer_id: string;
  request_id: string;
}

export class ErasureRepository {
  async customerExists(client: pg.PoolClient, merchantId: string, customerId: string): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    return Boolean(result.rowCount);
  }

  async findKeyForUpdate(
    client: pg.PoolClient,
    merchantId: string,
    key: string,
  ): Promise<ErasureKeyRow | undefined> {
    const result = await client.query<ErasureKeyRow>(
      `SELECT customer_id,request_id FROM customers.erasure_request_keys
       WHERE merchant_id=$1 AND key=$2 FOR UPDATE`,
      [merchantId, key],
    );
    return result.rows[0];
  }

  /** Returns false when the key is already bound to another request. */
  async bindKey(
    client: pg.PoolClient,
    merchantId: string,
    key: string,
    customerId: string,
    requestId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO customers.erasure_request_keys(merchant_id,key,customer_id,request_id)
       VALUES($1,$2,$3,$4) ON CONFLICT(merchant_id,key) DO NOTHING`,
      [merchantId, key, customerId, requestId],
    );
    return Boolean(result.rowCount);
  }

  async findByCustomerForUpdate(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
  ): Promise<ErasureRequestRecord | undefined> {
    const result = await client.query<ErasureRequestRecord>(
      `SELECT * FROM customers.erasure_requests
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findByIdForUpdate(
    client: pg.PoolClient,
    merchantId: string,
    requestId: string,
  ): Promise<ErasureRequestRecord | undefined> {
    const result = await client.query<ErasureRequestRecord>(
      `SELECT * FROM customers.erasure_requests
       WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRecord | undefined> {
    const result = await pool.query<ErasureRequestRecord>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  /** Creates the request, or returns the one already started for this customer. */
  async create(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
  ): Promise<{ row: ErasureRequestRecord; created: boolean }> {
    const inserted = await client.query<ErasureRequestRecord>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id)
       VALUES($1,$2) ON CONFLICT(merchant_id,customer_id) DO NOTHING RETURNING *`,
      [merchantId, customerId],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await client.query<ErasureRequestRecord>(
      `SELECT * FROM customers.erasure_requests
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return { row: existing.rows[0]!, created: false };
  }

  /** Requeues a failed request so a repost resumes the same workflow. */
  async requeue(client: pg.PoolClient, requestId: string): Promise<ErasureRequestRecord> {
    const result = await client.query<ErasureRequestRecord>(
      `UPDATE customers.erasure_requests
       SET status='pending',available_at=now(),last_error=NULL,updated_at=now()
       WHERE id=$1 AND status='failed' RETURNING *`,
      [requestId],
    );
    return result.rows[0]!;
  }

  async audit(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    action: string,
    correlationId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
       VALUES($1,'api_key','customer',$2,$3,$4,$5)`,
      [merchantId, customerId, action, metadata, correlationId],
    );
  }
}
