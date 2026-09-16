import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';

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

export class ErasureRepository {
  async createOrResume(client: pg.PoolClient, merchantId: string, customerId: string, key: string): Promise<ErasureRequest | undefined> {
    const customer = await client.query(`SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
    if (!customer.rowCount) return undefined;
    const keyOwner = await client.query<{ customer_id: string }>(
      `SELECT customer_id FROM customers.erasure_requests WHERE merchant_id=$1 AND idempotency_key=$2`, [merchantId, key],
    );
    if (keyOwner.rows[0] && keyOwner.rows[0].customer_id !== customerId) {
      throw Object.assign(new Error('idempotency key reused with different customer'), { statusCode: 409 });
    }
    const existing = await client.query<ErasureRequest>(
      `SELECT id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error
       FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].status === 'failed') {
        const resumed = await client.query<ErasureRequest>(
          `UPDATE customers.erasure_requests SET status='pending',updated_at=now(),last_error=NULL WHERE id=$1
           RETURNING id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`, [existing.rows[0].id],
        );
        return resumed.rows[0];
      }
      return existing.rows[0];
    }
    const result = await client.query<ErasureRequest>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id,idempotency_key)
       VALUES($1,$2,$3) RETURNING id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`,
      [merchantId, customerId, key],
    );
    return result.rows[0];
  }

  async find(merchantId: string, id: string): Promise<ErasureRequest | undefined> {
    const result = await pool.query<ErasureRequest>(
      `SELECT id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error
       FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`, [merchantId, id],
    );
    return result.rows[0];
  }

  async claim(): Promise<ErasureRequest & { merchant_id: string } | undefined> {
    const result = await pool.query<ErasureRequest & { merchant_id: string }>(
      `UPDATE customers.erasure_requests SET status='processing',attempts=attempts+1,updated_at=now(),last_error=NULL
       WHERE id=(SELECT id FROM customers.erasure_requests WHERE status IN ('pending','failed')
         ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error`,
    );
    return result.rows[0];
  }

  async complete(client: pg.PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests SET status='completed',completed_at=COALESCE(completed_at,now()),updated_at=now(),last_error=NULL WHERE id=$1`,
      [requestId],
    );
  }

  async fail(requestId: string, error: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests SET status='failed',last_error=$2,updated_at=now() WHERE id=$1`,
      [requestId, error],
    );
  }
}

export function publicErasureRequest(row: ErasureRequest): Record<string, unknown> {
  return {
    id: row.id, customerId: row.customer_id, status: row.status, attempts: row.attempts,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at, lastError: row.last_error,
  };
}
