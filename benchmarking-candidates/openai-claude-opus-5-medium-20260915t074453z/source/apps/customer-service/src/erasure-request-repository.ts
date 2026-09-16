import type { PoolClient } from 'pg';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../../packages/operations/src/retry-policy.js';
import { ERASURE_LEASE_EXPIRED, ERASURE_LEASE_SECONDS } from '../../../packages/privacy/src/erasure-policy.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  completed_steps: string[];
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ErasureRequestView {
  id: string;
  customerId: string;
  status: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

/** The public shape documented in `docs/privacy-api.md`; internal bookkeeping stays unexposed. */
export function toErasureRequestView(row: ErasureRequestRow): ErasureRequestView {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

export class ErasureRequestRepository {
  /**
   * Creates the request and its tombstone together. Writing the tombstone here, before any cleanup
   * runs, is what makes the guarantee hold: from the moment the merchant gets `202`, no delayed job,
   * replayed event, or provider callback can add the customer's personal data back.
   *
   * One request per customer is enforced by a unique constraint, so concurrent posts converge on the
   * same row instead of starting rival workflows.
   */
  async create(client: PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow> {
    const inserted = await client.query<ErasureRequestRow>(
      `INSERT INTO privacy.erasure_requests(merchant_id,customer_id)
       VALUES($1,$2) ON CONFLICT(merchant_id,customer_id) DO NOTHING RETURNING *`,
      [merchantId, customerId],
    );
    const request = inserted.rows[0] ?? await this.findByCustomerForUpdate(client, merchantId, customerId);
    await client.query(
      `INSERT INTO privacy.erased_customers(merchant_id,customer_id,request_id)
       VALUES($1,$2,$3) ON CONFLICT(merchant_id,customer_id) DO NOTHING`,
      [merchantId, customerId, request.id],
    );
    return request;
  }

  private async findByCustomerForUpdate(
    client: PoolClient,
    merchantId: string,
    customerId: string,
  ): Promise<ErasureRequestRow> {
    const existing = await client.query<ErasureRequestRow>(
      `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return existing.rows[0]!;
  }

  async findByCustomer(merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  /** Makes a request runnable again immediately, used when a merchant reposts a failed request. */
  async requeue(client: PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE privacy.erasure_requests SET available_at=now(),updated_at=now()
       WHERE id=$1 AND status IN ('pending','failed')`,
      [requestId],
    );
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE privacy.erasure_requests
       SET status='failed',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
           last_error=COALESCE(last_error,$1),updated_at=now()
       WHERE status='processing' AND lease_expires_at<now()`,
      [ERASURE_LEASE_EXPIRED],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Claims one runnable request under a lease. `attempts` counts here so a request that keeps dying
   * mid-step still reports progress to the merchant and still backs off.
   */
  async claim(workerId: string): Promise<ErasureRequestRow | undefined> {
    return await transaction(async (client) => {
      const result = await client.query<ErasureRequestRow>(
        `UPDATE privacy.erasure_requests
         SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
             lease_expires_at=now()+($2 || ' seconds')::interval,last_error=NULL,updated_at=now()
         WHERE id=(SELECT id FROM privacy.erasure_requests
           WHERE status IN ('pending','failed') AND available_at<=now()
           ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING *`,
        [workerId, ERASURE_LEASE_SECONDS],
      );
      return result.rows[0];
    });
  }

  /** Records a finished step so a later attempt skips it. */
  async recordStep(requestId: string, step: string): Promise<string[]> {
    const result = await pool.query<{ completed_steps: string[] }>(
      `UPDATE privacy.erasure_requests
       SET completed_steps=(SELECT array_agg(DISTINCT s) FROM unnest(completed_steps || $2::text) s),
           lease_expires_at=now()+($3 || ' seconds')::interval,updated_at=now()
       WHERE id=$1 RETURNING completed_steps`,
      [requestId, step, ERASURE_LEASE_SECONDS],
    );
    return result.rows[0]?.completed_steps ?? [];
  }

  async markCompleted(requestId: string): Promise<void> {
    await pool.query(
      `UPDATE privacy.erasure_requests
       SET status='completed',completed_at=COALESCE(completed_at,now()),locked_by=NULL,locked_at=NULL,
           lease_expires_at=NULL,last_error=NULL,updated_at=now()
       WHERE id=$1`,
      [requestId],
    );
  }

  /** Leaves the request retryable with a bounded backoff and a stable, PII-free error code. */
  async markFailed(request: ErasureRequestRow, code: string): Promise<void> {
    await pool.query(
      `UPDATE privacy.erasure_requests
       SET status='failed',available_at=now()+($2 || ' seconds')::interval,locked_by=NULL,locked_at=NULL,
           lease_expires_at=NULL,last_error=$3,updated_at=now()
       WHERE id=$1`,
      [request.id, boundedExponentialBackoffSeconds(request.attempts), code],
    );
  }
}
