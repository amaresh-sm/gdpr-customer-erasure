import type pg from 'pg';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../../packages/operations/src/retry-policy.js';
import type { ErasureRequestRow } from '../../customer-service/src/erasure.js';

export { type ErasureRequestRow };

export const MAX_ERASURE_ATTEMPTS = 8;
const LEASE_SECONDS = 120;

export class ErasureWorkerRepository {
  /** Failed requests keep their stable error code until the next attempt starts. */
  async claim(workerId: string): Promise<ErasureRequestRow | undefined> {
    return await transaction(async (client) => {
      const result = await client.query<ErasureRequestRow>(
        `UPDATE customers.erasure_requests
         SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),last_error=NULL,updated_at=now()
         WHERE id=(SELECT id FROM customers.erasure_requests
           WHERE (status='pending' OR (status='failed' AND attempts<$2)) AND next_attempt_at<=now()
           ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING *`,
        [workerId, MAX_ERASURE_ATTEMPTS],
      );
      return result.rows[0];
    });
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',last_error='worker_lease_expired',next_attempt_at=now(),
           locked_by=NULL,locked_at=NULL,updated_at=now()
       WHERE status='processing' AND locked_at<now()-($1 || ' seconds')::interval`,
      [LEASE_SECONDS],
    );
    return result.rowCount ?? 0;
  }

  async fail(request: ErasureRequestRow, code: string): Promise<void> {
    const exhausted = request.attempts >= MAX_ERASURE_ATTEMPTS;
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',last_error=$2,next_attempt_at=now()+($3 || ' seconds')::interval,
           locked_by=NULL,locked_at=NULL,updated_at=now()
       WHERE id=$1`,
      [request.id, code, exhausted ? 86_400 : boundedExponentialBackoffSeconds(request.attempts)],
    );
  }

  async complete(client: pg.PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='completed',completed_at=now(),last_error=NULL,locked_by=NULL,locked_at=NULL,updated_at=now()
       WHERE id=$1`,
      [requestId],
    );
  }
}
