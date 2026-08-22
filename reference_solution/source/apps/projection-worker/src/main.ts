import { Redis } from 'ioredis';
import type { EachMessagePayload } from 'kafkajs';
import { eventEnvelopeSchema, EVENT_TYPES, type EventEnvelope } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { pool } from '../../../packages/database/src/pool.js';
import { consumer, DOMAIN_TOPIC } from '../../../packages/messaging/src/kafka.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { erasedSubjectSurrogate } from '../../../packages/privacy/src/subjects.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';

process.env.SERVICE_NAME = 'projection-worker';
const redis = new Redis(config().REDIS_URL);
const kafka = consumer('payflow-projections-v1');

async function ensureIndex(): Promise<void> {
  const exists = await searchClient.indices.exists({ index: CUSTOMER_INDEX });
  if (!exists.body) await searchClient.indices.create({ index: CUSTOMER_INDEX, body: { mappings: { properties: {
    merchantId: { type: 'keyword' }, customerId: { type: 'keyword' }, email: { type: 'keyword' }, name: { type: 'text' },
    phone: { type: 'keyword' }, paymentStatus: { type: 'keyword' }, updatedAt: { type: 'date' },
  } } } });
}

async function project(event: EventEnvelope): Promise<void> {
  const customerId = typeof event.payload.customerId === 'string' ? event.payload.customerId : event.aggregateType === 'customer' ? event.aggregateId : undefined;
  const cacheKey = customerId ? `merchant:${event.merchantId}:customer:${customerId}` : undefined;
  if (customerId && await erasedSubjectSurrogate(event.merchantId, customerId)) {
    if (cacheKey) {
      await redis.del(cacheKey, `${cacheKey}:activity`);
      const documentId = `${event.merchantId}:${customerId}`;
      const exists = await searchClient.exists({ index: CUSTOMER_INDEX, id: documentId });
      if (exists.body) await searchClient.delete({ index: CUSTOMER_INDEX, id: documentId, refresh: true });
    }
    return;
  }
  if (event.eventType === EVENT_TYPES.CUSTOMER_CREATED || event.eventType === EVENT_TYPES.CUSTOMER_UPDATED) {
    const document = { merchantId: event.merchantId, customerId, email: event.payload.email, name: event.payload.name,
      phone: event.payload.phone, updatedAt: event.occurredAt };
    await searchClient.index({ index: CUSTOMER_INDEX, id: `${event.merchantId}:${customerId}`, body: document, refresh: false });
    if (cacheKey) await redis.set(cacheKey, JSON.stringify(document), 'EX', 3600);
  }
  if (cacheKey && event.eventType.startsWith('payment.')) {
    await redis.hset(`${cacheKey}:activity`, { lastEvent: event.eventType, lastPaymentId: String(event.payload.paymentId ?? ''),
      customerEmail: String(event.payload.customerEmail ?? ''), occurredAt: event.occurredAt });
  }
  await pool.query(
    `INSERT INTO operations.analytics_events(merchant_id,customer_id,anonymous_id,event_type,email,properties,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`, [event.merchantId, customerId ?? null, `anon_${event.aggregateId}`,
      event.eventType, event.payload.email ?? event.payload.customerEmail ?? null, event.payload, event.occurredAt],
  );
}

async function handle({ message, partition }: EachMessagePayload): Promise<void> {
  if (!message.value) return;
  const event = eventEnvelopeSchema.parse(JSON.parse(message.value.toString()));
  const inserted = await pool.query(
    `INSERT INTO operations.inbox_events(consumer,event_id,event_type,status)
     VALUES('projection-worker',$1,$2,'processing') ON CONFLICT DO NOTHING`, [event.eventId, event.eventType],
  );
  if (!inserted.rowCount) return;
  try {
    await project(event);
    await pool.query(`UPDATE operations.inbox_events SET status='processed',processed_at=now() WHERE consumer='projection-worker' AND event_id=$1`, [event.eventId]);
    await pool.query(
      `INSERT INTO operations.projection_checkpoints(projection,partition,offset_value)
       VALUES('customer-activity',$1,$2) ON CONFLICT(projection,partition) DO UPDATE SET offset_value=$2,updated_at=now()`,
      [partition, Number(message.offset)],
    );
  } catch (error) {
    await pool.query(`UPDATE operations.inbox_events SET status='failed',error=$2 WHERE consumer='projection-worker' AND event_id=$1`,
      [event.eventId, error instanceof Error ? error.message : String(error)]);
    throw error;
  }
}

await ensureIndex();
await kafka.connect();
await kafka.subscribe({ topic: DOMAIN_TOPIC, fromBeginning: true });
await kafka.run({ eachMessage: handle });
logger.info('projection worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void kafka.disconnect(); void redis.quit(); });
