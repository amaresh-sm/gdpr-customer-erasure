import { pool, transaction } from '../../../packages/database/src/pool.js';
import type { EventEnvelope } from '../../../packages/contracts/src/events.js';

export class ProjectionRepository {
  async claim(event: EventEnvelope): Promise<boolean> {
    const result = await pool.query(
      `INSERT INTO operations.inbox_events(consumer,event_id,event_type,status)
       VALUES('projection-worker',$1,$2,'processing')
       ON CONFLICT(consumer,event_id) DO UPDATE SET status='processing',error=NULL
       WHERE operations.inbox_events.status<>'processed'
       RETURNING event_id`,
      [event.eventId, event.eventType],
    );
    return Boolean(result.rowCount);
  }

  async complete(event: EventEnvelope, customerId: string | undefined, partition: number, offset: number): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO operations.analytics_events
         (merchant_id,customer_id,anonymous_id,event_type,email,properties,occurred_at,source_event_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING`,
        [
          event.merchantId,
          customerId ?? null,
          `anon_${event.aggregateId}`,
          event.eventType,
          event.payload.email ?? event.payload.customerEmail ?? null,
          event.payload,
          event.occurredAt,
          event.eventId,
        ],
      );
      await client.query(
        `UPDATE operations.inbox_events SET status='processed',processed_at=now(),error=NULL
         WHERE consumer='projection-worker' AND event_id=$1`,
        [event.eventId],
      );
      await client.query(
        `INSERT INTO operations.projection_checkpoints(projection,partition,offset_value)
         VALUES('customer-activity',$1,$2)
         ON CONFLICT(projection,partition) DO UPDATE SET offset_value=GREATEST(
           operations.projection_checkpoints.offset_value,EXCLUDED.offset_value
         ),updated_at=now()`,
        [partition, offset],
      );
    });
  }

  async fail(eventId: string, error: unknown): Promise<void> {
    await pool.query(
      `UPDATE operations.inbox_events SET status='failed',error=$2
       WHERE consumer='projection-worker' AND event_id=$1`,
      [eventId, error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)],
    );
  }
}
