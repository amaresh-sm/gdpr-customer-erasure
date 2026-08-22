import { pool, transaction } from '../../../packages/database/src/pool.js';
import { logger } from '../../../packages/observability/src/logger.js';
import type { ErasureRequestRecord } from '../../../packages/privacy/src/types.js';
import { PARTICIPANTS } from './workflow.js';

async function claimRequest(): Promise<ErasureRequestRecord | undefined> {
  return transaction(async (client) => {
    const result = await client.query<ErasureRequestRecord>(
      `UPDATE privacy.erasure_requests SET
         status='processing',attempts=attempts+1,started_at=COALESCE(started_at,now()),
         updated_at=now(),lease_until=now()+interval '30 seconds',last_error=NULL
       WHERE id=(
         SELECT id FROM privacy.erasure_requests
         WHERE attempts<max_attempts AND next_attempt_at<=now() AND (
           status='pending' OR status='failed' OR (status='processing' AND lease_until<now())
         ) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING *`,
    );
    return result.rows[0];
  });
}

async function runParticipant(request: ErasureRequestRecord, participant: typeof PARTICIPANTS[number]): Promise<void> {
  const step = await pool.query<{ status: string }>(
    `SELECT status FROM privacy.erasure_steps WHERE request_id=$1 AND participant=$2`,
    [request.id, participant.name],
  );
  if (step.rows[0]?.status === 'completed') return;
  await pool.query(
    `UPDATE privacy.erasure_steps SET status='processing',attempts=attempts+1,last_error=NULL,
     started_at=COALESCE(started_at,now()),updated_at=now() WHERE request_id=$1 AND participant=$2`,
    [request.id, participant.name],
  );
  try {
    await participant.run(request);
    await pool.query(
      `UPDATE privacy.erasure_steps SET status='completed',completed_at=now(),updated_at=now()
       WHERE request_id=$1 AND participant=$2`, [request.id, participant.name],
    );
    await pool.query(`UPDATE privacy.erasure_requests SET lease_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1`,
      [request.id]);
  } catch (error) {
    await pool.query(
      `UPDATE privacy.erasure_steps SET status='failed',last_error=$3,updated_at=now()
       WHERE request_id=$1 AND participant=$2`,
      [request.id, participant.name, error instanceof Error ? error.message.slice(0, 500) : 'participant_error'],
    );
    throw Object.assign(error instanceof Error ? error : new Error('participant failed'), { participant: participant.name });
  }
}

async function completeRequest(request: ErasureRequestRecord): Promise<void> {
  await pool.query(
    `UPDATE privacy.erasure_requests SET status='completed',completed_at=now(),updated_at=now(),
     lease_until=NULL,last_error=NULL,subject_context=$2 WHERE id=$1`,
    [request.id, { merchantId: request.merchant_id, customerId: request.customer_id,
      surrogateId: request.surrogate_id, sensitiveValues: [] }],
  );
}

async function failRequest(request: ErasureRequestRecord, error: unknown): Promise<void> {
  const participant = (error as { participant?: string }).participant ?? 'workflow';
  const delay = Math.min(30, 2 ** request.attempts);
  await pool.query(
    `UPDATE privacy.erasure_requests SET status='failed',last_error=$2,updated_at=now(),lease_until=NULL,
     next_attempt_at=now()+($3 || ' seconds')::interval WHERE id=$1`,
    [request.id, `${participant}_failed`, delay],
  );
  logger.error({ error, erasureRequestId: request.id, participant }, 'erasure attempt failed');
}

async function processRequest(request: ErasureRequestRecord): Promise<void> {
  try {
    for (const participant of PARTICIPANTS) await runParticipant(request, participant);
    await completeRequest(request);
  } catch (error) {
    await failRequest(request, error);
  }
}

/** Runs the durable single-request claim loop until shutdown. */
export async function runErasureWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const request = await claimRequest();
    if (!request) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    await processRequest(request);
  }
}
