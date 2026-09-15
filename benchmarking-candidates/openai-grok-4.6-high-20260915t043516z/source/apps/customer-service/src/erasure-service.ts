import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import {
  erasedEmail,
  REDACTED,
  redactJson,
} from '../../../packages/privacy/src/redact.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { upsertTombstone } from '../../../packages/privacy/src/tombstones.js';
import { completeIdempotency, requestHash, reserveIdempotency } from './idempotency.js';
import { ErasureRepository } from './erasure-repository.js';
import {
  piiValuesFrom,
  toPublicErasureRequest,
  type CollectedCustomerPii,
  type PublicErasureRequest,
} from './erasure-types.js';

const redis = new Redis(config().REDIS_URL);

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  async create(
    merchantId: string, customerId: string, idempotencyKey: string,
  ): Promise<{ status: number; body: PublicErasureRequest }> {
    const existing = await this.repository.findByCustomer(merchantId, customerId);
    if (existing) {
      const row = existing.status === 'failed'
        ? await transaction((client) => this.repository.requeue(client, existing.id))
        : existing;
      return { status: 202, body: toPublicErasureRequest(row) };
    }
    if (!await this.repository.customerExists(merchantId, customerId)) {
      throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });
    }
    return transaction(async (client) => {
      const hash = requestHash({ customerId });
      const replay = await reserveIdempotency(client, merchantId, 'create-erasure', idempotencyKey, hash);
      if (replay) return { status: replay.status, body: replay.body as PublicErasureRequest };
      const created = await this.repository.create(client, merchantId, customerId);
      const body = toPublicErasureRequest(created);
      await completeIdempotency(client, merchantId, 'create-erasure', idempotencyKey, 202, body);
      return { status: 202, body };
    });
  }

  async get(merchantId: string, requestId: string): Promise<PublicErasureRequest | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? toPublicErasureRequest(row) : undefined;
  }

  async process(requestId: string, merchantId: string, customerId: string): Promise<void> {
    const collected = await this.repository.collect(merchantId, customerId);
    await transaction(async (client) => {
      await upsertTombstone(client, merchantId, customerId, requestId);
    });
    await this.purgeOutboundEmail(collected);
    await this.redactDocuments(merchantId, customerId, collected);
    await this.redactSearchAndCache(merchantId, customerId);
    await transaction(async (client) => {
      await this.repository.redactDatabase(client, merchantId, customerId, collected);
      const published = await client.query(
        `SELECT 1 FROM operations.outbox_events
         WHERE event_type=$1 AND aggregate_id=$2 AND merchant_id=$3 LIMIT 1`,
        [EVENT_TYPES.CUSTOMER_ERASED, customerId, merchantId],
      );
      if (!published.rowCount) {
        await addOutboxEvent(client, {
          eventType: EVENT_TYPES.CUSTOMER_ERASED, aggregateType: 'customer',
          aggregateId: customerId, merchantId, correlationId: requestId,
          payload: { customerId, requestId },
        });
      }
      await this.repository.markCompleted(client, requestId);
    });
  }

  async claim(): Promise<{ id: string; merchant_id: string; customer_id: string } | undefined> {
    return this.repository.claim();
  }

  async recoverExpiredLeases(): Promise<number> {
    return this.repository.recoverExpiredLeases();
  }

  async fail(requestId: string, error: unknown): Promise<void> {
    await this.repository.markFailed(requestId, stableErrorCode(error));
  }

  private async purgeOutboundEmail(collected: CollectedCustomerPii): Promise<void> {
    const destinations = [...new Set(collected.emails.concat(collected.contacts).filter((value) => value.includes('@')))];
    for (const destination of destinations) {
      if (destination.endsWith('@erased.invalid')) continue;
      await deleteMailpitMessagesForRecipient(destination);
    }
  }

  private async redactDocuments(
    merchantId: string, customerId: string, collected: CollectedCustomerPii,
  ): Promise<void> {
    const pii = piiValuesFrom(collected);
    const financial = await this.repository.listFinancialDocumentKeys(merchantId, customerId);
    const retained = new Set(financial.map((document) => document.object_key));
    for (const document of financial) {
      await rewriteStoredJson(document.object_key, pii, customerId);
    }
    const importKeys = await this.repository.listImportObjectKeys(merchantId);
    const candidates = new Set([...importKeys, ...collected.documentKeys]);
    for (const key of candidates) {
      if (retained.has(key)) continue;
      const raw = await readObject(key);
      const owned = collected.documentKeys.includes(key) || key.includes(customerId);
      if (raw === undefined) {
        if (owned) await this.repository.deleteStoredDocument(key);
        continue;
      }
      if (owned || raw.includes(customerId) || pii.some((value) => value.length >= 5 && raw.includes(value))) {
        await removeObject(key);
        await this.repository.deleteStoredDocument(key);
      }
    }
  }

  private async redactSearchAndCache(merchantId: string, customerId: string): Promise<void> {
    const document = {
      merchantId, customerId, email: erasedEmail(customerId), name: REDACTED,
      phone: null, paymentStatus: null, updatedAt: new Date().toISOString(), erased: true,
    };
    await searchClient.index({
      index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}`, body: document, refresh: true,
    });
    const cacheKey = `merchant:${merchantId}:customer:${customerId}`;
    await redis.set(cacheKey, JSON.stringify(document), 'EX', 3600);
    await redis.del(`${cacheKey}:activity`);
  }
}

function stableErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('mailpit')) return 'notification_store_unavailable';
  if (message.includes('opensearch') || message.includes('index_not_found')) return 'search_unavailable';
  if (message.includes('minio') || message.includes('S3Error') || message.includes('The specified key does not exist')) {
    return 'document_store_unavailable';
  }
  if (message.includes('ECONNREFUSED') || message.includes('timeout')) return 'dependency_unavailable';
  return 'erasure_step_failed';
}

async function readObject(objectKey: string): Promise<string | undefined> {
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'NotFound' || code === 'NoSuchKey') return undefined;
    throw error;
  }
}

async function rewriteStoredJson(objectKey: string, pii: string[], customerId: string): Promise<void> {
  const raw = await readObject(objectKey);
  if (raw === undefined) return;
  let parsed: unknown = raw;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  const redacted = redactJson(parsed, pii);
  if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
    const record = redacted as Record<string, unknown>;
    if (record.customer && typeof record.customer === 'object') {
      record.customer = { ...(record.customer as Record<string, unknown>), email: erasedEmail(customerId), name: REDACTED, phone: null };
    }
  }
  const body = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  await objectStore.putObject(DOCUMENT_BUCKET, objectKey, body, Buffer.byteLength(body), { 'Content-Type': 'application/json' });
  const checksum = createHash('sha256').update(body).digest('hex');
  await pool.query(
    `UPDATE operations.document_manifests SET checksum=$2, metadata = metadata || $3::jsonb WHERE object_key=$1`,
    [objectKey, checksum, { erased: true }],
  );
}

async function removeObject(objectKey: string): Promise<void> {
  try {
    await objectStore.removeObject(DOCUMENT_BUCKET, objectKey);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'NotFound' && code !== 'NoSuchKey') throw error;
  }
}
