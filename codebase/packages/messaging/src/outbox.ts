import type pg from 'pg';
import { v4 as uuid } from 'uuid';
import type { EventEnvelope } from '../../contracts/src/events.js';

export async function addOutboxEvent(
  client: pg.PoolClient,
  event: Omit<EventEnvelope, 'eventId' | 'occurredAt' | 'eventVersion'> & { eventVersion?: number },
): Promise<EventEnvelope> {
  const envelope: EventEnvelope = {
    ...event,
    eventId: uuid(),
    occurredAt: new Date().toISOString(),
    eventVersion: event.eventVersion ?? 1,
  };
  await client.query(
    `INSERT INTO operations.outbox_events
      (id,event_type,event_version,aggregate_type,aggregate_id,merchant_id,correlation_id,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [envelope.eventId, envelope.eventType, envelope.eventVersion, envelope.aggregateType,
     envelope.aggregateId, envelope.merchantId, envelope.correlationId, envelope.payload],
  );
  return envelope;
}
