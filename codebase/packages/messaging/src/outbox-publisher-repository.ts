import { pool, transaction } from '../../database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../operations/src/retry-policy.js';

export interface ClaimedOutboxEvent {
  id: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  merchant_id: string;
  correlation_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
  attempts: number;
}

export async function recoverExpiredOutboxLeases(): Promise<number> {
  const result = await pool.query(
    `UPDATE operations.outbox_events
     SET status='pending',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
         last_error=COALESCE(last_error,'publisher_lease_expired')
     WHERE status='publishing' AND lease_expires_at<now()`,
  );
  return result.rowCount ?? 0;
}

export async function claimOutboxEvents(workerId: string, limit = 50): Promise<ClaimedOutboxEvent[]> {
  return await transaction(async (client) => {
    const result = await client.query<ClaimedOutboxEvent>(
      `WITH candidates AS (
         SELECT id FROM operations.outbox_events
         WHERE status='pending' AND available_at<=now()
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE operations.outbox_events event
       SET status='publishing',attempts=event.attempts+1,locked_by=$1,locked_at=now(),
           lease_expires_at=now()+interval '60 seconds',last_error=NULL
       FROM candidates WHERE event.id=candidates.id
       RETURNING event.id,event.event_type,event.event_version,event.aggregate_type,event.aggregate_id,
                 event.merchant_id,event.correlation_id,event.payload,event.created_at,event.attempts`,
      [workerId, limit],
    );
    return result.rows;
  });
}

export async function markOutboxPublished(id: string, workerId: string): Promise<void> {
  await pool.query(
    `UPDATE operations.outbox_events
     SET status='published',published_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=NULL
     WHERE id=$1 AND locked_by=$2`,
    [id, workerId],
  );
}

export async function markOutboxFailed(event: ClaimedOutboxEvent, workerId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  if (event.attempts >= 12) {
    await transaction(async (client) => {
      const failed = await client.query(
        `UPDATE operations.outbox_events
         SET status='dead',locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=$3
         WHERE id=$1 AND locked_by=$2 RETURNING id,event_type,payload`,
        [event.id, workerId, message],
      );
      if (!failed.rowCount) return;
      await client.query(
        `INSERT INTO operations.dead_letters(source,source_id,event_type,payload,error)
         VALUES('outbox_event',$1,$2,$3,$4)`,
        [event.id, event.event_type, event.payload, message],
      );
    });
    return;
  }

  await pool.query(
    `UPDATE operations.outbox_events
     SET status='pending',available_at=now()+($3 || ' seconds')::interval,
         locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=$4
     WHERE id=$1 AND locked_by=$2`,
    [event.id, workerId, boundedExponentialBackoffSeconds(event.attempts), message],
  );
}
