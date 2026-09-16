import { pool, transaction } from '../../../packages/database/src/pool.js';

export interface ClaimedWebhook {
  id: string;
  payload: unknown;
  attempts: number;
}

export class WebhookRepository {
  async accept(providerEventId: string, eventType: string, signature: string, payload: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO operations.provider_webhooks(provider_event_id,event_type,signature,payload)
       VALUES($1,$2,$3,$4) ON CONFLICT(provider_event_id) DO NOTHING`,
      [providerEventId, eventType, signature, payload],
    );
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE operations.provider_webhooks
       SET status='retry',next_attempt_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
           last_error=COALESCE(last_error,'worker_lease_expired')
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string): Promise<ClaimedWebhook | undefined> {
    const result = await pool.query<ClaimedWebhook>(
      `UPDATE operations.provider_webhooks
       SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
           lease_expires_at=now()+interval '60 seconds',last_error=NULL
       WHERE id=(SELECT id FROM operations.provider_webhooks
         WHERE status IN ('pending','retry') AND next_attempt_at<=now()
         ORDER BY next_attempt_at,received_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,payload,attempts`,
      [workerId],
    );
    return result.rows[0];
  }

  async fail(webhook: ClaimedWebhook, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    if (webhook.attempts >= 8) {
      await transaction(async (client) => {
        const failed = await client.query<{ id: string; event_type: string; payload: unknown }>(
          `UPDATE operations.provider_webhooks
           SET status='dead',locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=$2
           WHERE id=$1 RETURNING id,event_type,payload`,
          [webhook.id, message],
        );
        const row = failed.rows[0];
        if (!row) return;
        await client.query(
          `INSERT INTO operations.dead_letters(source,source_id,event_type,payload,error)
           VALUES('provider_webhook',$1,$2,$3,$4)`,
          [row.id, row.event_type, row.payload, message],
        );
      });
      return;
    }
    await pool.query(
      `UPDATE operations.provider_webhooks
       SET status='retry',next_attempt_at=now()+($2 || ' seconds')::interval,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=$3
       WHERE id=$1`,
      [webhook.id, Math.min(300, 2 ** webhook.attempts), message],
    );
  }
}
