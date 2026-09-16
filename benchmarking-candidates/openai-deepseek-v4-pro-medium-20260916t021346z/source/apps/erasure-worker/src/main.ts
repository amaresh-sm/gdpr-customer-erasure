import type { EachMessagePayload } from 'kafkajs';
import { EVENT_TYPES, eventEnvelopeSchema } from '../../../packages/contracts/src/events.js';
import { consumer, DOMAIN_TOPIC } from '../../../packages/messaging/src/kafka.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { CustomerService } from '../../../apps/customer-service/src/service.js';

process.env.SERVICE_NAME = 'erasure-worker';
const kafka = consumer('payflow-erasure-v1');
const service = new CustomerService();

async function processErasure(event: ReturnType<typeof eventEnvelopeSchema.parse>): Promise<void> {
  const customerId = String(event.payload.customerId ?? '');
  const requestId = String(event.payload.requestId ?? '');
  if (!customerId || !requestId) {
    logger.error({ eventId: event.eventId }, 'erasure event missing customerId or requestId');
    return;
  }

  const inboxResult = await pool.query(
    `INSERT INTO operations.inbox_events(consumer,event_id,event_type,status)
     VALUES('erasure-worker',$1,$2,'processing')
     ON CONFLICT(consumer,event_id) DO NOTHING
     RETURNING event_id`,
    [event.eventId, event.eventType],
  );
  if (!inboxResult.rowCount) return;

  try {
    await service.executeErasure(event.merchantId, customerId, requestId);
    await pool.query(
      `UPDATE operations.inbox_events SET status='processed',processed_at=now()
       WHERE consumer='erasure-worker' AND event_id=$1`,
      [event.eventId],
    );
    logger.info({ customerId, requestId }, 'erasure completed');
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    logger.error({ error, customerId, requestId }, 'erasure failed');
    await transaction(async (client) => {
      await service.failErasure(event.merchantId, requestId, message);
      await client.query(
        `UPDATE operations.inbox_events SET status='failed',error=$2
         WHERE consumer='erasure-worker' AND event_id=$1`,
        [event.eventId, message],
      );
    });
  }
}

async function handle({ message }: EachMessagePayload): Promise<void> {
  if (!message.value) return;
  const event = eventEnvelopeSchema.parse(JSON.parse(message.value.toString()));
  if (event.eventType !== EVENT_TYPES.CUSTOMER_ERASED) return;
  await processErasure(event);
}

await kafka.connect();
await kafka.subscribe({ topic: DOMAIN_TOPIC, fromBeginning: true });
await kafka.run({ eachMessage: handle });
logger.info('erasure worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void kafka.disconnect(); });