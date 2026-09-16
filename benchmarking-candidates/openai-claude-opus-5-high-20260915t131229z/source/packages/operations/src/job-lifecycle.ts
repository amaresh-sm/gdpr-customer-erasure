import type { PoolClient } from 'pg';
import { transaction } from '../../database/src/pool.js';
import { boundedExponentialBackoffSeconds } from './retry-policy.js';

export interface DurableJob<TPayload> {
  id: string;
  merchant_id: string;
  job_type: string;
  payload: TPayload;
  attempts: number;
  max_attempts: number;
}

export interface ClaimedJob<TPayload> extends DurableJob<TPayload> {
  attemptId: string;
}

export function nextRetryDelaySeconds(attempts: number, maximum = 300): number {
  return boundedExponentialBackoffSeconds(attempts, maximum);
}

export async function recoverExpiredJobLeases(queue: string): Promise<number> {
  const result = await transaction(async (client) => await client.query(
    `UPDATE operations.jobs
     SET status='retry', available_at=now(), locked_by=NULL, locked_at=NULL, lease_expires_at=NULL,
         last_error=COALESCE(last_error, 'worker_lease_expired')
     WHERE queue=$1 AND status='processing' AND lease_expires_at < now()`,
    [queue],
  ));
  return result.rowCount ?? 0;
}

export async function claimJob<TPayload>(queue: string, workerId: string, leaseSeconds = 60): Promise<ClaimedJob<TPayload> | undefined> {
  return await transaction(async (client) => {
    const result = await client.query<DurableJob<TPayload>>(
      `UPDATE operations.jobs
       SET status='processing', attempts=attempts+1, locked_by=$1, locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval, last_error=NULL
       WHERE id=(SELECT id FROM operations.jobs
         WHERE queue=$3 AND status IN ('pending','retry') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,job_type,payload,attempts,max_attempts`,
      [workerId, leaseSeconds, queue],
    );
    const job = result.rows[0];
    if (!job) return undefined;
    const attempt = await client.query<{ id: string }>(
      `INSERT INTO operations.job_attempts(job_id,worker_id,status,started_at)
       VALUES($1,$2,'processing',now()) RETURNING id`,
      [job.id, workerId],
    );
    return { ...job, attemptId: attempt.rows[0]!.id };
  });
}

export async function completeJob(client: PoolClient, job: ClaimedJob<unknown>): Promise<void> {
  await client.query(
    `UPDATE operations.jobs
     SET status='completed', locked_by=NULL, locked_at=NULL, lease_expires_at=NULL, last_error=NULL
     WHERE id=$1`,
    [job.id],
  );
  await client.query(
    `UPDATE operations.job_attempts SET status='completed',finished_at=now() WHERE id=$1`,
    [job.attemptId],
  );
}

export async function failJob(client: PoolClient, job: ClaimedJob<unknown>, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  await client.query(
    `UPDATE operations.job_attempts SET status='failed',error=$2,finished_at=now() WHERE id=$1`,
    [job.attemptId, message],
  );
  if (job.attempts >= job.max_attempts) {
    await client.query(
      `WITH failed AS (
        UPDATE operations.jobs
        SET status='dead',locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=$2
        WHERE id=$1 RETURNING *
      )
      INSERT INTO operations.dead_letters(source,source_id,event_type,payload,error)
      SELECT 'job',id::text,job_type,payload,$2 FROM failed`,
      [job.id, message],
    );
    return;
  }

  await client.query(
    `UPDATE operations.jobs
     SET status='retry',available_at=now()+($2 || ' seconds')::interval,
         locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=$3
     WHERE id=$1`,
    [job.id, nextRetryDelaySeconds(job.attempts), message],
  );
}
