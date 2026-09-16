import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../../packages/operations/src/retry-policy.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  idempotency_key: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  last_error: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ClaimedErasureRequest {
  id: string;
  merchant_id: string;
  customer_id: string;
  attempts: number;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export class ErasureRepository {
  /**
   * Reserves an erasure request for a customer. A customer can only ever have one erasure
   * request, so a repeated call (whether the idempotency key matches or not) returns the
   * existing row instead of starting another workflow. Reusing a key already bound to a
   * different customer is rejected before any row is created.
   */
  async reserve(merchantId: string, customerId: string, idempotencyKey: string): Promise<{ row: ErasureRequestRow; created: boolean }> {
    try {
      const inserted = await pool.query<ErasureRequestRow>(
        `INSERT INTO customers.erasure_requests(merchant_id,customer_id,idempotency_key)
         VALUES($1,$2,$3)
         ON CONFLICT ON CONSTRAINT erasure_requests_customer_unique DO NOTHING
         RETURNING *`,
        [merchantId, customerId, idempotencyKey],
      );
      if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    } catch (error) {
      if (isUniqueViolation(error, 'erasure_requests_idempotency_unique')) {
        throw Object.assign(new Error('idempotency key reused for a different customer'), { statusCode: 409 });
      }
      throw error;
    }
    const existing = await pool.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    return { row: existing.rows[0]!, created: false };
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
       SET status='failed', available_at=now(), locked_by=NULL, locked_at=NULL, lease_expires_at=NULL,
           last_error=COALESCE(last_error,'worker_lease_expired')
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseSeconds = 60): Promise<ClaimedErasureRequest | undefined> {
    const result = await pool.query<ClaimedErasureRequest>(
      `UPDATE customers.erasure_requests
       SET status='processing', attempts=attempts+1, locked_by=$1, locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval, last_error=NULL
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status IN ('pending','failed') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,customer_id,attempts`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  }

  async markCompleted(client: pg.PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='completed', completed_at=now(), locked_by=NULL, locked_at=NULL, lease_expires_at=NULL, last_error=NULL
       WHERE id=$1`,
      [requestId],
    );
  }

  /** Records a stable, customer-data-free error code and schedules a bounded backoff retry. */
  async markFailed(requestId: string, attempts: number, errorCode: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed', available_at=now()+($3 || ' seconds')::interval,
           locked_by=NULL, locked_at=NULL, lease_expires_at=NULL, last_error=$2
       WHERE id=$1`,
      [requestId, errorCode, boundedExponentialBackoffSeconds(attempts)],
    );
  }
}
