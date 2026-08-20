import type { EachMessagePayload } from 'kafkajs';
import { EVENT_TYPES, eventEnvelopeSchema } from '../../../packages/contracts/src/events.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { consumer, DOMAIN_TOPIC } from '../../../packages/messaging/src/kafka.js';
import { logger } from '../../../packages/observability/src/logger.js';

process.env.SERVICE_NAME = 'notification-worker';
const kafka = consumer('payflow-notifications-v1');
const templates: Partial<Record<string, string>> = {
  [EVENT_TYPES.PAYMENT_SUCCEEDED]: 'payment-receipt',
  [EVENT_TYPES.PAYMENT_FAILED]: 'payment-failed',
  [EVENT_TYPES.PAYMENT_REFUNDED]: 'refund-confirmation',
  [EVENT_TYPES.INVOICE_ISSUED]: 'invoice-issued',
};

async function handle({ message }: EachMessagePayload): Promise<void> {
  if (!message.value) return;
  const event = eventEnvelopeSchema.parse(JSON.parse(message.value.toString()));
  const template = templates[event.eventType];
  if (!template) return;
  await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO operations.inbox_events(consumer,event_id,event_type,status)
       VALUES('notification-worker',$1,$2,'processing') ON CONFLICT DO NOTHING`, [event.eventId, event.eventType],
    );
    if (!inserted.rowCount) return;
    const destination = String(event.payload.customerEmail ?? event.payload.email ?? '');
    const customerId = typeof event.payload.customerId === 'string' ? event.payload.customerId : null;
    if (destination) {
      await client.query(
        `INSERT INTO operations.notification_preferences(merchant_id,customer_id,channel,destination)
         VALUES($1,$2,'email',$3) ON CONFLICT(merchant_id,customer_id,channel)
         DO UPDATE SET destination=EXCLUDED.destination,updated_at=now()`, [event.merchantId, customerId, destination],
      );
      await client.query(
        `INSERT INTO operations.notifications(merchant_id,customer_id,channel,destination,template,payload,status,attempts,delivered_at)
         VALUES($1,$2,'email',$3,$4,$5,'delivered',1,now())`, [event.merchantId, customerId, destination, template, event.payload],
      );
    }
    await client.query(`UPDATE operations.inbox_events SET status='processed',processed_at=now()
      WHERE consumer='notification-worker' AND event_id=$1`, [event.eventId]);
  });
}

await kafka.connect();
await kafka.subscribe({ topic: DOMAIN_TOPIC, fromBeginning: true });
await kafka.run({ eachMessage: handle });
logger.info('notification worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void kafka.disconnect());
