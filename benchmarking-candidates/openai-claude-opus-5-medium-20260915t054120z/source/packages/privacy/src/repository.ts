import type pg from 'pg';
import { pool, transaction } from '../../database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../operations/src/retry-policy.js';
import type { ErasureStep } from './redaction.js';

export type ErasureStatus = 'pending' | 'processing' | 'failed' | 'completed';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: ErasureStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ErasureRequestView {
  id: string;
  customerId: string;
  status: ErasureStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

const REQUEST_COLUMNS =
  'id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at';

export function serializeErasureRequest(row: ErasureRequestRow): ErasureRequestView {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    lastError: row.last_error,
  };
}

export async function findRequestById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
  const result = await pool.query<ErasureRequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM privacy.erasure_requests WHERE merchant_id=$1 AND id=$2`,
    [merchantId, requestId],
  );
  return result.rows[0];
}

export async function findRequestForCustomer(
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

export async function customerExists(client: pg.PoolClient, merchantId: string, customerId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

export async function insertRequest(
  client: pg.PoolClient,
  merchantId: string,
  customerId: string,
): Promise<ErasureRequestRow> {
  const result = await client.query<ErasureRequestRow>(
    `INSERT INTO privacy.erasure_requests(merchant_id,customer_id) VALUES($1,$2)
     RETURNING ${REQUEST_COLUMNS}`,
    [merchantId, customerId],
  );
  return result.rows[0]!;
}

/** Requeues a request whose previous attempt failed without discarding finished steps. */
export async function requeueRequest(
  client: pg.PoolClient,
  requestId: string,
): Promise<ErasureRequestRow | undefined> {
  const result = await client.query<ErasureRequestRow>(
    `UPDATE privacy.erasure_requests
     SET status='pending',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND status='failed' RETURNING ${REQUEST_COLUMNS}`,
    [requestId],
  );
  return result.rows[0];
}

export async function recordAudit(
  client: pg.PoolClient,
  merchantId: string,
  customerId: string,
  action: string,
  requestId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
     VALUES($1,'api_key','customer',$2,$3,jsonb_build_object('requestId',$4::text),$4::uuid)`,
    [merchantId, customerId, action, requestId],
  );
}

export async function recoverExpiredErasureLeases(): Promise<number> {
  const result = await pool.query(
    `UPDATE privacy.erasure_requests
     SET status='failed',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
         last_error=COALESCE(last_error,'erasure_lease_expired'),updated_at=now()
     WHERE status='processing' AND lease_expires_at<now()`,
  );
  return result.rowCount ?? 0;
}

export async function claimRequest(workerId: string, leaseSeconds = 60): Promise<ErasureRequestRow | undefined> {
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

export async function completedSteps(requestId: string): Promise<Set<string>> {
  const result = await pool.query<{ step: string }>(
    `SELECT step FROM privacy.erasure_steps WHERE request_id=$1`,
    [requestId],
  );
  return new Set(result.rows.map((row) => row.step));
}

export async function recordStep(client: pg.PoolClient, requestId: string, step: ErasureStep): Promise<void> {
  await client.query(
    `INSERT INTO privacy.erasure_steps(request_id,step) VALUES($1,$2)
     ON CONFLICT(request_id,step) DO NOTHING`,
    [requestId, step],
  );
}

/**
 * Publishes the terminal state of a finished request together with its audit trail, so a
 * request is never reported complete without the record of the deletion.
 */
export async function markRequestCompleted(request: ErasureRequestRow): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `UPDATE privacy.erasure_requests
       SET status='completed',completed_at=COALESCE(completed_at,now()),locked_by=NULL,locked_at=NULL,
           lease_expires_at=NULL,last_error=NULL,updated_at=now()
       WHERE id=$1`,
      [request.id],
    );
    await recordAudit(client, request.merchant_id, request.customer_id, 'privacy.erasure.completed', request.id);
  });
}

/** Schedules another attempt. A request that already finished is never regressed. */
export async function markRequestFailed(request: ErasureRequestRow, errorCode: string): Promise<void> {
  await pool.query(
    `UPDATE privacy.erasure_requests
     SET status='failed',available_at=now()+($2 || ' seconds')::interval,locked_by=NULL,locked_at=NULL,
         lease_expires_at=NULL,last_error=$3,updated_at=now()
     WHERE id=$1 AND status='processing'`,
    [request.id, boundedExponentialBackoffSeconds(request.attempts), errorCode],
  );
}

/** Runs one erasure step inside a transaction and records it as finished atomically. */
export async function withStep<T>(
  requestId: string,
  step: ErasureStep,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return await transaction(async (client) => {
    const result = await work(client);
    await recordStep(client, requestId, step);
    return result;
  });
}
