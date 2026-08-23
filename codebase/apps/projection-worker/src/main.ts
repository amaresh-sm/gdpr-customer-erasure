import { Redis } from 'ioredis';
import type { EachMessagePayload } from 'kafkajs';
import { eventEnvelopeSchema, EVENT_TYPES, type EventEnvelope } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { consumer, DOMAIN_TOPIC } from '../../../packages/messaging/src/kafka.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { ProjectionRepository } from './repository.js';

process.env.SERVICE_NAME = 'projection-worker';
const redis = new Redis(config().REDIS_URL);
const kafka = consumer('payflow-projections-v1');
const repository = new ProjectionRepository();

async function ensureIndex(): Promise<void> {
  const exists = await searchClient.indices.exists({ index: CUSTOMER_INDEX });
  if (!exists.body) await searchClient.indices.create({
    index: CUSTOMER_INDEX, body: {
      mappings: {
        properties: {
          merchantId: { type: 'keyword' }, customerId: { type: 'keyword' }, email: { type: 'keyword' }, name: { type: 'text' },
          phone: { type: 'keyword' }, paymentStatus: { type: 'keyword' }, updatedAt: { type: 'date' },
        }
      }
    }
  });
}

async function project(event: EventEnvelope): Promise<void> {
  const customerId = typeof event.payload.customerId === 'string' ? event.payload.customerId : event.aggregateType === 'customer' ? event.aggregateId : undefined;
  const cacheKey = customerId ? `merchant:${event.merchantId}:customer:${customerId}` : undefined;
  if (event.eventType === EVENT_TYPES.CUSTOMER_CREATED || event.eventType === EVENT_TYPES.CUSTOMER_UPDATED) {
    const document = {
      merchantId: event.merchantId, customerId, email: event.payload.email, name: event.payload.name,
      phone: event.payload.phone, updatedAt: event.occurredAt
    };
    await searchClient.index({ index: CUSTOMER_INDEX, id: `${event.merchantId}:${customerId}`, body: document, refresh: false });
    if (cacheKey) await redis.set(cacheKey, JSON.stringify(document), 'EX', 3600);
  }
  if (cacheKey && event.eventType.startsWith('payment.')) {
    await redis.hset(`${cacheKey}:activity`, {
      lastEvent: event.eventType, lastPaymentId: String(event.payload.paymentId ?? ''),
      customerEmail: String(event.payload.customerEmail ?? ''), occurredAt: event.occurredAt
    });
  }
}

async function handle({ message, partition }: EachMessagePayload): Promise<void> {
  if (!message.value) return;
  const event = eventEnvelopeSchema.parse(JSON.parse(message.value.toString()));
  if (!await repository.claim(event)) return;
  const customerId = typeof event.payload.customerId === 'string'
    ? event.payload.customerId
    : event.aggregateType === 'customer' ? event.aggregateId : undefined;
  try {
    await project(event);
    await repository.complete(event, customerId, partition, Number(message.offset));
  } catch (error) {
    await repository.fail(event.eventId, error);
    throw error;
  }
}

await ensureIndex();
await kafka.connect();
await kafka.subscribe({ topic: DOMAIN_TOPIC, fromBeginning: true });
await kafka.run({ eachMessage: handle });
logger.info('projection worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void kafka.disconnect(); void redis.quit(); });
