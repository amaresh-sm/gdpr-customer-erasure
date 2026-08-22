import { pool, transaction } from '../../database/src/pool.js';
import { DOMAIN_TOPIC, producer } from './kafka.js';
import { logger } from '../../observability/src/logger.js';

export async function startOutboxPublisher(signal: AbortSignal): Promise<void> {
  const kafka = producer();
  await kafka.connect();
  try {
    while (!signal.aborted) {
      const events = await transaction(async (client) => {
        const result = await client.query(
          `SELECT * FROM operations.outbox_events
           WHERE status='pending' AND available_at<=now()
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 50`,
        );
        if (result.rowCount) {
          await client.query(`UPDATE operations.outbox_events SET status='publishing',attempts=attempts+1 WHERE id=ANY($1)`,
                             [result.rows.map((row) => row.id)]);
        }
        return result.rows;
      });
      for (const row of events) {
        try {
          await kafka.send({ topic: DOMAIN_TOPIC, messages: [{ key: row.aggregate_id, value: JSON.stringify({
            eventId: row.id, eventType: row.event_type, eventVersion: row.event_version,
            occurredAt: row.created_at, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
            merchantId: row.merchant_id, correlationId: row.correlation_id, payload: row.payload,
          }) }] });
          await pool.query(`UPDATE operations.outbox_events SET status='published',published_at=now() WHERE id=$1`, [row.id]);
        } catch (error) {
          logger.error({ error, eventId: row.id }, 'outbox publish failed');
          await pool.query(`UPDATE operations.outbox_events SET status='pending',available_at=now()+interval '5 seconds' WHERE id=$1`, [row.id]);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, events.length ? 50 : 500));
    }
  } finally {
    await kafka.disconnect();
  }
}
