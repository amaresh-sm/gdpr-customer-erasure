import type { EachMessagePayload } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { EVENT_TYPES, eventEnvelopeSchema } from '../../../packages/contracts/src/events.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { consumer, DOMAIN_TOPIC } from '../../../packages/messaging/src/kafka.js';
import {
  claimEmailDelivery,
  markEmailDelivered,
  markEmailFailed,
  recoverExpiredDeliveryLeases,
} from '../../../packages/notifications/src/delivery-lifecycle.js';
import { sendMailpitEmail } from '../../../packages/notifications/src/mailpit.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { recordEmailDelivery } from './repository.js';

process.env.SERVICE_NAME = 'notification-worker';
const kafka = consumer('payflow-notifications-v1');
const workerId = `notification-worker-${randomUUID()}`;
let lastLeaseRecovery = 0;
const templates: Partial<Record<string, string>> = {
  [EVENT_TYPES.PAYMENT_SUCCEEDED]: 'payment-receipt',
  [EVENT_TYPES.PAYMENT_FAILED]: 'payment-failed',
  [EVENT_TYPES.PAYMENT_REFUNDED]: 'refund-confirmation',
  [EVENT_TYPES.INVOICE_ISSUED]: 'invoice-issued',
};

function content(template: string, payload: Record<string, unknown>): { subject: string; text: string; html: string } {
  const subject = `PayFlow ${template.replaceAll('-', ' ')}`;
  const text = `${subject}\n\n${JSON.stringify(payload)}`;
  return { subject, text, html: `<h1>${subject}</h1><pre>${JSON.stringify(payload)}</pre>` };
}

async function recordDelivery(event: ReturnType<typeof eventEnvelopeSchema.parse>, template: string): Promise<void> {
  const destination = String(event.payload.customerEmail ?? event.payload.email ?? '');
  if (!destination) return;
  await recordEmailDelivery(event, template, destination, content(template, event.payload));
}

async function deliverOne(): Promise<boolean> {
  const delivery = await claimEmailDelivery(workerId);
  if (!delivery) return false;
  try {
    const providerMessageId = await sendMailpitEmail({
      messageKey: delivery.message_key, destination: delivery.destination,
      subject: delivery.subject, textBody: delivery.text_body, htmlBody: delivery.html_body
    });
    await transaction(async (client) => await markEmailDelivered(client, delivery, providerMessageId));
  } catch (error) {
    await transaction(async (client) => await markEmailFailed(client, delivery, error));
  }
  return true;
}

async function deliverAvailable(): Promise<void> {
  if (Date.now() - lastLeaseRecovery > 30_000) {
    await recoverExpiredDeliveryLeases();
    lastLeaseRecovery = Date.now();
  }
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
