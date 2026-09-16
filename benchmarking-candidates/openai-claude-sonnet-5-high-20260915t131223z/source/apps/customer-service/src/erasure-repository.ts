import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../../packages/operations/src/retry-policy.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  last_error: string | null;
}

export interface ClaimedErasureRequest extends ErasureRequestRow {
  status: 'processing';
}

export class ErasureRepository {
  /** Reserves an idempotency key for a customer, returning the customer it already belongs to (if any). */
  async reserveIdempotencyKey(
    client: pg.PoolClient,
    merchantId: string,
    idempotencyKey: string,
    customerId: string,
  ): Promise<string> {
    const inserted = await client.query<{ customer_id: string }>(
      `INSERT INTO customers.erasure_idempotency_keys(merchant_id,idempotency_key,customer_id)
       VALUES($1,$2,$3) ON CONFLICT(merchant_id,idempotency_key) DO NOTHING RETURNING customer_id`,
      [merchantId, idempotencyKey, customerId],
    );
    if (inserted.rows[0]) return inserted.rows[0].customer_id;
    const existing = await client.query<{ customer_id: string }>(
      `SELECT customer_id FROM customers.erasure_idempotency_keys WHERE merchant_id=$1 AND idempotency_key=$2`,
      [merchantId, idempotencyKey],
    );
    return existing.rows[0]!.customer_id;
  }

  async createRequest(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id) VALUES($1,$2)
       ON CONFLICT(merchant_id,customer_id) DO NOTHING RETURNING *`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findByCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  /** Re-queues a failed request so the worker retries it promptly; leaves in-flight/completed requests untouched. */
  async resumeIfFailed(client: pg.PoolClient, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests SET status='pending',available_at=now(),updated_at=now()
       WHERE id=$1 AND status='failed' RETURNING *`,
      [requestId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
           last_error=COALESCE(last_error,'worker_lease_expired'),updated_at=now()
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseSeconds = 60): Promise<ClaimedErasureRequest | undefined> {
    const result = await pool.query<ClaimedErasureRequest>(
      `UPDATE customers.erasure_requests
       SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval,updated_at=now()
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status IN ('pending','failed') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  }

  async complete(requestId: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='completed',completed_at=now(),updated_at=now(),
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=NULL
       WHERE id=$1`,
      [requestId],
    );
  }

  async fail(request: ErasureRequestRow, errorCode: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',available_at=now()+($3 || ' seconds')::interval,last_error=$2,updated_at=now(),
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL
       WHERE id=$1`,
      [request.id, errorCode, boundedExponentialBackoffSeconds(request.attempts)],
    );
  }
}
