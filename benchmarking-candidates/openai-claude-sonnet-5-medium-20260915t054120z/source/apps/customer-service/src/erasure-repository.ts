import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export class ErasureRepository {
  async findCustomerMerchant(merchantId: string, customerId: string): Promise<{ id: string } | undefined> {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findByCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async create(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id) VALUES($1,$2) RETURNING *`,
      [merchantId, customerId],
    );
    return result.rows[0]!;
  }

  /** Resolves the idempotency key to the customer id it was first used for, if any. */
  async findIdempotencyKey(
    client: pg.PoolClient, merchantId: string, key: string,
  ): Promise<{ customer_id: string; erasure_request_id: string } | undefined> {
    const result = await client.query<{ customer_id: string; erasure_request_id: string }>(
      `SELECT customer_id,erasure_request_id FROM customers.erasure_idempotency_keys
       WHERE merchant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [merchantId, key],
    );
    return result.rows[0];
  }

  async recordIdempotencyKey(
    client: pg.PoolClient, merchantId: string, key: string, customerId: string, erasureRequestId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO customers.erasure_idempotency_keys(merchant_id,idempotency_key,customer_id,erasure_request_id)
       VALUES($1,$2,$3,$4) ON CONFLICT(merchant_id,idempotency_key) DO NOTHING`,
      [merchantId, key, customerId, erasureRequestId],
    );
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }
}
