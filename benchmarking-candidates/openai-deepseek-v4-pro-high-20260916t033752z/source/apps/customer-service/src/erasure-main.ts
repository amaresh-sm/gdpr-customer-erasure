import { randomUUID } from 'node:crypto';
import { EVENT_TYPES, eventEnvelopeSchema, type EventEnvelope } from '../../../packages/contracts/src/events.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { consumer, DOMAIN_TOPIC } from '../../../packages/messaging/src/kafka.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureRepository } from './erasure-repository.js';
import { eraseCustomerPII } from './erasure-worker.js';

process.env.SERVICE_NAME = 'erasure-worker';
const kafka = consumer('payflow-erasure-v1');
const erasureRepo = new ErasureRepository();

async function processErasure(event: EventEnvelope): Promise<void> {
  const requestId = typeof event.payload.erasureRequestId === 'string' ? event.payload.erasureRequestId : undefined;
  if (!requestId) return;

  await transaction(async (client) => {
    const request = await erasureRepo.claimNext(client);
    if (!request || request.id !== requestId) return;

    try {
      await eraseCustomerPII(client, {
        merchantId: request.merchant_id,
        customerId: request.customer_id,
      });
      await erasureRepo.markCompleted(client, request.id);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      if (request.attempts >= 8) {
        await erasureRepo.markDead(client, request.id, message);
      } else {
        await erasureRepo.markFailed(client, request.id, message);
      }
    }
  });
}

async function handle({ message }: { message: { value: Buffer | null } }): Promise<void> {
  if (!message.value) return;
  const event = eventEnvelopeSchema.parse(JSON.parse(message.value.toString()));
  if (event.eventType !== EVENT_TYPES.CUSTOMER_DATA_ERASED) return;
  await processErasure(event);
}

await kafka.connect();
await kafka.subscribe({ topic: DOMAIN_TOPIC, fromBeginning: true });
await kafka.run({ eachMessage: handle });
logger.info('erasure worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void kafka.disconnect(); });