import type pg from 'pg';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../../packages/operations/src/retry-policy.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  last_error: string | null;
}

export interface ClaimedErasureRequest extends ErasureRequestRow {
  status: 'processing';
}

const SELECT_COLUMNS = 'id,merchant_id,customer_id,status,attempts,created_at,updated_at,completed_at,last_error';

export class ErasureRepository {
  /** Returns the existing request for this customer, if one has already been accepted. */
  async findByCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT ${SELECT_COLUMNS} FROM customers.erasure_requests
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT ${SELECT_COLUMNS} FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  /** Locks the customer row and returns it, or undefined if it does not belong to this merchant. */
  async lockCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<{ id: string } | undefined> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async create(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id) VALUES($1,$2)
       RETURNING ${SELECT_COLUMNS}`,
      [merchantId, customerId],
    );
    return result.rows[0]!;
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
           last_error=COALESCE(last_error,'worker_lease_expired')
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseSeconds = 60): Promise<ClaimedErasureRequest | undefined> {
    return await transaction(async (client) => {
      const result = await client.query<ErasureRequestRow>(
        `UPDATE customers.erasure_requests
         SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
             lease_expires_at=now()+($2 || ' seconds')::interval,updated_at=now()
         WHERE id=(SELECT id FROM customers.erasure_requests
           WHERE status IN ('pending','failed') AND available_at<=now()
           ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING ${SELECT_COLUMNS}`,
        [workerId, leaseSeconds],
      );
      return result.rows[0] as ClaimedErasureRequest | undefined;
    });
  }

  async complete(client: pg.PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='completed',completed_at=now(),updated_at=now(),locked_by=NULL,locked_at=NULL,
           lease_expires_at=NULL,last_error=NULL
       WHERE id=$1`,
      [requestId],
    );
  }

  async fail(request: ClaimedErasureRequest, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',available_at=now()+($2 || ' seconds')::interval,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=$3,updated_at=now()
       WHERE id=$1`,
      [request.id, boundedExponentialBackoffSeconds(request.attempts), message],
    );
  }
}
