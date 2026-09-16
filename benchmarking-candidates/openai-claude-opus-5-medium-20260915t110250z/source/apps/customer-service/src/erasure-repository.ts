import type pg from 'pg';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../../packages/operations/src/retry-policy.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ErasureSubject {
  email: string | null;
}

const REQUEST_COLUMNS =
  'id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at';

export class ErasureRepository {
  async findByCustomer(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
  ): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM privacy.erasure_requests
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM privacy.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  /** Creates the request only when the customer is still owned by the authenticated merchant. */
  async create(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
  ): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `INSERT INTO privacy.erasure_requests(merchant_id,customer_id)
       SELECT $1,id FROM customers.customers WHERE merchant_id=$1 AND id=$2
       RETURNING ${REQUEST_COLUMNS}`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE privacy.erasure_requests
       SET status='failed',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
           last_error=COALESCE(last_error,'erasure_lease_expired'),updated_at=now()
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseSeconds = 60): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `UPDATE privacy.erasure_requests
       SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval,updated_at=now()
       WHERE id=(SELECT id FROM privacy.erasure_requests
         WHERE status IN ('pending','failed') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING ${REQUEST_COLUMNS}`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  }

  /**
   * Marks the request complete and drops the step bookkeeping, which is only needed while cleanup
   * is still resumable. The tombstone in `privacy.erased_customers` is what outlives the request.
   */
  async complete(requestId: string): Promise<void> {
    await transaction(async (client) => {
      await client.query(`DELETE FROM privacy.erasure_steps WHERE request_id=$1`, [requestId]);
      await client.query(
        `UPDATE privacy.erasure_requests
         SET status='completed',completed_at=COALESCE(completed_at,now()),locked_by=NULL,locked_at=NULL,
             lease_expires_at=NULL,last_error=NULL,updated_at=now()
         WHERE id=$1`,
        [requestId],
      );
    });
  }

  async fail(request: ErasureRequestRow, errorCode: string): Promise<void> {
    await pool.query(
      `UPDATE privacy.erasure_requests
       SET status='failed',available_at=now()+($2 || ' seconds')::interval,locked_by=NULL,locked_at=NULL,
           lease_expires_at=NULL,last_error=$3,updated_at=now()
       WHERE id=$1`,
      [request.id, boundedExponentialBackoffSeconds(request.attempts), errorCode],
    );
  }

  async completedSteps(requestId: string): Promise<Set<string>> {
    const result = await pool.query<{ step: string }>(
      `SELECT step FROM privacy.erasure_steps WHERE request_id=$1`,
      [requestId],
    );
    return new Set(result.rows.map((row) => row.step));
  }

  async recordStep(client: pg.PoolClient, requestId: string, step: string): Promise<void> {
    await client.query(
      `INSERT INTO privacy.erasure_steps(request_id,step) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [requestId, step],
    );
  }

  /** Reads the contact details needed to clean up systems keyed by address rather than identifier. */
  async subject(merchantId: string, customerId: string): Promise<ErasureSubject> {
    const result = await pool.query<{ email: string }>(
      `SELECT email FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    const destinations = await pool.query<{ destination: string }>(
      `SELECT DISTINCT destination FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    return { email: result.rows[0]?.email ?? destinations.rows[0]?.destination ?? null };
  }
}
