import { randomUUID } from 'node:crypto';
import { logger } from '../../observability/src/logger.js';
import { DOMAIN_TOPIC, producer } from './kafka.js';
import {
  claimOutboxEvents,
  markOutboxFailed,
  markOutboxPublished,
  recoverExpiredOutboxLeases,
} from './outbox-publisher-repository.js';

/** Publishes committed outbox rows with crash-recoverable leases and bounded retry. */
export async function startOutboxPublisher(signal: AbortSignal): Promise<void> {
  const kafka = producer();
  const workerId = `${process.env.SERVICE_NAME ?? 'service'}-outbox-${randomUUID()}`;
  let lastLeaseRecovery = 0;
  await kafka.connect();
  try {
    while (!signal.aborted) {
      if (Date.now() - lastLeaseRecovery > 30_000) {
        await recoverExpiredOutboxLeases();
        lastLeaseRecovery = Date.now();
      }
      const events = await claimOutboxEvents(workerId);
      for (const event of events) {
        try {
          await kafka.send({
            topic: DOMAIN_TOPIC,
            messages: [{
              key: event.aggregate_id,
              value: JSON.stringify({
                eventId: event.id,
                eventType: event.event_type,
                eventVersion: event.event_version,
                occurredAt: event.created_at,
                aggregateType: event.aggregate_type,
                aggregateId: event.aggregate_id,
                merchantId: event.merchant_id,
                correlationId: event.correlation_id,
                payload: event.payload,
              }),
            }],
          });
          await markOutboxPublished(event.id, workerId);
        } catch (error) {
          logger.error({ error, eventId: event.id }, 'outbox publish failed');
          await markOutboxFailed(event, workerId, error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, events.length ? 50 : 500));
    }
  } finally {
    await kafka.disconnect();
  }
}
