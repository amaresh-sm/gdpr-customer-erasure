import type { PoolClient } from 'pg';
import { pool } from '../../../packages/database/src/pool.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export class ErasureRepository {
  async create(
    client: PoolClient,
    merchantId: string,
    customerId: string,
  ): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id)
       VALUES($1,$2)
       ON CONFLICT(merchant_id,customer_id) DO UPDATE
       SET updated_at=now()
       RETURNING *`,
      [merchantId, customerId],
    );
    return result.rows[0]!;
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async findByCustomer(merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async claimNext(client: PoolClient): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='processing', attempts=attempts+1, updated_at=now(), last_error=NULL
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status IN ('pending','retry') AND updated_at <= now()
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
    );
    return result.rows[0];
  }

  async markCompleted(client: PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='completed', completed_at=now(), updated_at=now()
       WHERE id=$1`,
      [requestId],
    );
  }

  async markFailed(client: PoolClient, requestId: string, error: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='retry', last_error=$2, updated_at=now()
       WHERE id=$1`,
      [requestId, error],
    );
  }

  async markDead(client: PoolClient, requestId: string, error: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='failed', last_error=$2, updated_at=now()
       WHERE id=$1`,
      [requestId, error],
    );
  }
}