import type { EachMessagePayload } from 'kafkajs';
import { EVENT_TYPES, eventEnvelopeSchema } from '../../../packages/contracts/src/events.js';
import { pool, transaction, withAdvisoryLock } from '../../../packages/database/src/pool.js';
import { consumer, DOMAIN_TOPIC } from '../../../packages/messaging/src/kafka.js';
import { sendMailpitEmail } from '../../../packages/notifications/src/mailpit.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { isErasedSubject } from '../../../packages/privacy/src/subjects.js';

process.env.SERVICE_NAME = 'notification-worker';
const kafka = consumer('payflow-notifications-v1');
const templates: Partial<Record<string, string>> = {
  [EVENT_TYPES.PAYMENT_SUCCEEDED]: 'payment-receipt',
  [EVENT_TYPES.PAYMENT_FAILED]: 'payment-failed',
  [EVENT_TYPES.PAYMENT_REFUNDED]: 'refund-confirmation',
  [EVENT_TYPES.INVOICE_ISSUED]: 'invoice-issued',
};

interface Delivery {
  id: string;
  merchant_id: string;
  customer_id: string | null;
  destination: string;
  template: string;
  subject: string;
  text_body: string;
  html_body: string;
  message_key: string;
  attempts: number;
}

function content(template: string, payload: Record<string, unknown>): { subject: string; text: string; html: string } {
  const subject = `PayFlow ${template.replaceAll('-', ' ')}`;
  const text = `${subject}\n\n${JSON.stringify(payload)}`;
  return { subject, text, html: `<h1>${subject}</h1><pre>${JSON.stringify(payload)}</pre>` };
}

async function recordDelivery(event: ReturnType<typeof eventEnvelopeSchema.parse>, template: string): Promise<void> {
  await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO operations.inbox_events(consumer,event_id,event_type,status)
       VALUES('notification-worker',$1,$2,'processing') ON CONFLICT DO NOTHING`, [event.eventId, event.eventType],
    );
    if (!inserted.rowCount) return;
    const customerId = typeof event.payload.customerId === 'string' ? event.payload.customerId : null;
    if (customerId && await isErasedSubject(event.merchantId, customerId, client)) {
      await client.query(`UPDATE operations.inbox_events SET status='processed',processed_at=now()
        WHERE consumer='notification-worker' AND event_id=$1`, [event.eventId]);
      return;
    }
    const destination = String(event.payload.customerEmail ?? event.payload.email ?? '');
    if (destination) {
      const rendered = content(template, event.payload);
      await client.query(
        `INSERT INTO operations.notification_preferences(merchant_id,customer_id,channel,destination)
         VALUES($1,$2,'email',$3) ON CONFLICT(merchant_id,customer_id,channel)
         DO UPDATE SET destination=EXCLUDED.destination,updated_at=now()`, [event.merchantId, customerId, destination],
      );
      await client.query(
        `INSERT INTO operations.notifications(merchant_id,customer_id,channel,destination,template,payload,status,attempts)
         VALUES($1,$2,'email',$3,$4,$5,'queued',0)`, [event.merchantId, customerId, destination, template, event.payload],
      );
      await client.query(
        `INSERT INTO operations.email_deliveries
         (merchant_id,customer_id,destination,template,subject,text_body,html_body)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [event.merchantId, customerId, destination, template, rendered.subject, rendered.text, rendered.html],
      );
    }
    await client.query(`UPDATE operations.inbox_events SET status='processed',processed_at=now()
      WHERE consumer='notification-worker' AND event_id=$1`, [event.eventId]);
  });
}

async function claimDelivery(): Promise<Delivery | undefined> {
  return await transaction(async (client) => {
    const candidate = await client.query<Delivery>(
      `SELECT * FROM operations.email_deliveries
       WHERE status IN ('pending','failed') AND attempts<max_attempts AND available_at<=now()
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const delivery = candidate.rows[0];
    if (!delivery) return undefined;
    if (delivery.customer_id && await isErasedSubject(delivery.merchant_id, delivery.customer_id, client)) {
      await client.query(
        `UPDATE operations.email_deliveries
         SET customer_id=(SELECT surrogate_id FROM privacy.erased_subjects WHERE merchant_id=$2 AND customer_id=$3),
           destination='[redacted]',subject='[redacted]',text_body='[redacted]',html_body='[redacted]',
           provider_message_id=NULL,status='cancelled',cancelled_at=now(),last_error=NULL
         WHERE id=$1`, [delivery.id, delivery.merchant_id, delivery.customer_id],
      );
      return undefined;
    }
    const result = await client.query<Delivery>(
      `UPDATE operations.email_deliveries SET status='processing',attempts=attempts+1,last_error=NULL
       WHERE id=$1 RETURNING *`, [delivery.id],
    );
    return result.rows[0];
  });
}

async function deliverOne(): Promise<boolean> {
  const delivery = await claimDelivery();
  if (!delivery) return false;
  const lockKey = delivery.customer_id ? `privacy:${delivery.merchant_id}:${delivery.customer_id}` : undefined;
  const send = async (): Promise<void> => {
    if (delivery.customer_id && await isErasedSubject(delivery.merchant_id, delivery.customer_id)) {
      await pool.query(
        `UPDATE operations.email_deliveries SET customer_id=(SELECT surrogate_id FROM privacy.erased_subjects WHERE merchant_id=$2 AND customer_id=$3),
         destination='[redacted]',subject='[redacted]',text_body='[redacted]',html_body='[redacted]',
         provider_message_id=NULL,status='cancelled',cancelled_at=now(),last_error=NULL WHERE id=$1`,
        [delivery.id, delivery.merchant_id, delivery.customer_id],
      );
      return;
    }
    try {
      const providerMessageId = await sendMailpitEmail({ messageKey: delivery.message_key, destination: delivery.destination,
        subject: delivery.subject, textBody: delivery.text_body, htmlBody: delivery.html_body });
      await pool.query(
        `UPDATE operations.email_deliveries SET status='delivered',provider_message_id=$2,delivered_at=now(),last_error=NULL
         WHERE id=$1 AND status='processing'`, [delivery.id, providerMessageId ?? null],
      );
      await pool.query(
        `UPDATE operations.notifications SET status='delivered',attempts=attempts+1,delivered_at=now()
         WHERE merchant_id=$1 AND customer_id IS NOT DISTINCT FROM $2 AND destination=$3 AND template=$4 AND status='queued'`,
        [delivery.merchant_id, delivery.customer_id, delivery.destination, delivery.template],
      );
    } catch (error) {
      const delay = Math.min(30, 2 ** delivery.attempts);
      await pool.query(
        `UPDATE operations.email_deliveries SET status='failed',last_error=$2,available_at=now()+($3 || ' seconds')::interval
         WHERE id=$1 AND status='processing'`,
        [delivery.id, error instanceof Error ? error.message.slice(0, 300) : 'provider_error', delay],
      );
    }
  };
  if (lockKey) await withAdvisoryLock(lockKey, async () => await send());
  else await send();
  return true;
}

async function deliverAvailable(): Promise<void> {
  for (let count = 0; count < 20; count += 1) {
    if (!await deliverOne()) return;
  }
}

async function handle({ message }: EachMessagePayload): Promise<void> {
  if (!message.value) return;
  const event = eventEnvelopeSchema.parse(JSON.parse(message.value.toString()));
  const template = templates[event.eventType];
  if (!template) return;
  await recordDelivery(event, template);
  await deliverAvailable();
}

await kafka.connect();
await kafka.subscribe({ topic: DOMAIN_TOPIC, fromBeginning: true });
await kafka.run({ eachMessage: handle });
const deliveryTimer = setInterval(() => { void deliverAvailable().catch((error) => logger.error({ error }, 'email delivery failed')); }, 250);
logger.info('notification worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  clearInterval(deliveryTimer);
  void kafka.disconnect();
});
