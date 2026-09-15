import type { PoolClient } from 'pg';
import { pool, transaction } from '../../database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../operations/src/retry-policy.js';
import { toErasureErrorCode } from './errors.js';

export interface ClaimedErasureRequest {
  id: string;
  merchant_id: string;
  customer_id: string;
  attempts: number;
}

/**
 * Recovers erasure requests whose worker crashed mid-processing. Left as
 * `failed` (not `completed`) so a retry is required before the request can
 * ever be reported as done; regulatory erasure must never be recovered
 * unless every step actually ran.
 */
export async function recoverExpiredErasureLeases(): Promise<number> {
  const result = await pool.query(
    `UPDATE customers.erasure_requests
     SET status='failed', available_at=now(), locked_by=NULL, locked_at=NULL, lease_expires_at=NULL,
         last_error=COALESCE(last_error, 'worker_lease_expired')
     WHERE status='processing' AND lease_expires_at < now()`,
  );
  return result.rowCount ?? 0;
}

export async function claimErasureRequest(workerId: string, leaseSeconds = 120): Promise<ClaimedErasureRequest | undefined> {
  return await transaction(async (client) => {
    const result = await client.query<ClaimedErasureRequest>(
      `UPDATE customers.erasure_requests
       SET status='processing', attempts=attempts+1, locked_by=$1, locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval, updated_at=now()
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status IN ('pending','failed') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,customer_id,attempts`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  });
}

export async function completeErasureRequest(request: ClaimedErasureRequest): Promise<void> {
  await pool.query(
    `UPDATE customers.erasure_requests
     SET status='completed', completed_at=now(), updated_at=now(), last_error=NULL,
         locked_by=NULL, locked_at=NULL, lease_expires_at=NULL
     WHERE id=$1`,
    [request.id],
  );
}

export async function failErasureRequest(client: PoolClient, request: ClaimedErasureRequest, error: unknown): Promise<void> {
  const code = toErasureErrorCode(error);
  await client.query(
    `UPDATE customers.erasure_requests
     SET status='failed', available_at=now()+($2 || ' seconds')::interval, last_error=$3, updated_at=now(),
         locked_by=NULL, locked_at=NULL, lease_expires_at=NULL
     WHERE id=$1`,
    [request.id, boundedExponentialBackoffSeconds(request.attempts), code],
  );
}
