import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { completeIdempotency, requestHash, reserveIdempotency } from '../../../packages/operations/src/idempotency.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import { classifyErasureError, erasedCustomerRecord, redactPii } from '../../../packages/privacy/src/redact.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { ErasureRepository, type ErasureRequestRow } from './erasure-repository.js';

export interface PublicErasureRequest {
  id: string;
  customerId: string;
  status: ErasureRequestRow['status'];
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

function serialize(row: ErasureRequestRow): PublicErasureRequest {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    lastError: row.last_error,
  };
}

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  async create(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<{ status: number; body: PublicErasureRequest }> {
    const hash = requestHash({ customerId });
    const created = await transaction(async (client) => {
      const replay = await reserveIdempotency(client, merchantId, 'create-erasure', idempotencyKey, hash);
      const existing = await this.repository.findExisting(client, merchantId, customerId);
      if (replay) {
        if (existing?.status === 'failed') {
          const request = serialize(await this.repository.requeue(client, existing));
          await completeIdempotency(client, merchantId, 'create-erasure', idempotencyKey, 202, request);
          return { request };
        }
        return existing ? { request: serialize(existing) } : { replay };
      }
      const customer = await this.repository.findCustomer(client, merchantId, customerId);
      if (!customer) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });
      const requestRow = existing
        ? existing.status === 'failed' ? await this.repository.requeue(client, existing) : existing
        : await this.repository.create(client, merchantId, customerId);
      await this.repository.ensureTombstone(client, merchantId, customerId, requestRow.id);
      await this.repository.markCustomerErasing(client, merchantId, customerId);
      const request = serialize(requestRow);
      await addOutboxEvent(client, {
        eventType: EVENT_TYPES.CUSTOMER_ERASURE_REQUESTED,
        aggregateType: 'customer',
        aggregateId: customerId,
        merchantId,
        correlationId: uuid(),
        payload: { customerId, erasureRequestId: requestRow.id, status: requestRow.status },
      });
      await completeIdempotency(client, merchantId, 'create-erasure', idempotencyKey, 202, request);
      return { request };
    });
    if ('replay' in created) {
      return { status: created.replay!.status, body: created.replay!.body as PublicErasureRequest };
    }
    return { status: 202, body: created.request };
  }

  async get(merchantId: string, requestId: string): Promise<PublicErasureRequest | undefined> {
    const row = await this.repository.findForMerchant(merchantId, requestId);
    return row ? serialize(row) : undefined;
  }

  async processOne(): Promise<boolean> {
    const request = await this.repository.claimRunnable();
    if (!request) return false;
    try {
      await this.cleanup(request);
    } catch (error) {
      await this.repository.markFailed(request.id, classifyErasureError(error));
    }
    return true;
  }

  private async cleanup(request: ErasureRequestRow): Promise<void> {
    const snapshot = await transaction(async (client) => {
      const customer = await this.repository.findCustomer(client, request.merchant_id, request.customer_id);
      await this.repository.ensureTombstone(client, request.merchant_id, request.customer_id, request.id);
      await this.repository.markCustomerErasing(client, request.merchant_id, request.customer_id);
      return customer;
    });
    const destinations = await this.repository.listCustomerEmails(
      request.merchant_id, request.customer_id, snapshot?.email ?? null,
    );
    await this.purgeSearchAndCache(request.merchant_id, request.customer_id);
    await this.purgeNotifications(destinations);
    await this.rewriteMatchingObjects(request.merchant_id, request.customer_id, snapshot?.email ?? null);
    await transaction(async (client) => {
      await this.repository.redactOperationalRecords(client, request.merchant_id, request.customer_id);
      await this.repository.markCompleted(client, request.id);
      await addOutboxEvent(client, {
        eventType: EVENT_TYPES.CUSTOMER_ERASED,
        aggregateType: 'customer',
        aggregateId: request.customer_id,
        merchantId: request.merchant_id,
        correlationId: uuid(),
        payload: { customerId: request.customer_id, erasureRequestId: request.id },
      });
    });
    await this.purgeSearchAndCache(request.merchant_id, request.customer_id);
  }

  private async purgeSearchAndCache(merchantId: string, customerId: string): Promise<void> {
    const document = { merchantId, customerId, status: 'erased', updatedAt: new Date().toISOString() };
    try {
      await searchClient.index({
        index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}`, body: document, refresh: true,
      });
    } catch (error) {
      const status = (error as { meta?: { statusCode?: number } }).meta?.statusCode;
      if (status !== 404) throw error;
    }
    const redis = new Redis(config().REDIS_URL);
    try {
      const cacheKey = `merchant:${merchantId}:customer:${customerId}`;
      await redis.set(cacheKey, JSON.stringify(document), 'EX', 3600);
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor, 'MATCH', `merchant:${merchantId}:customer:${customerId}:*`, 'COUNT', 100,
        );
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
    } finally {
      await redis.quit();
    }
  }

  private async purgeNotifications(destinations: string[]): Promise<void> {
    for (const destination of destinations) {
      await deleteMailpitMessagesForRecipient(destination);
    }
  }

  private async rewriteMatchingObjects(merchantId: string, customerId: string, email: string | null): Promise<void> {
    const keys = await this.repository.listMerchantObjectKeys(merchantId, customerId);
    for (const objectKey of keys) {
      const raw = await this.readObject(objectKey);
      if (raw === undefined) continue;
      const belongsToCustomer = objectKey.includes(customerId)
        || raw.includes(customerId)
        || (email !== null && raw.includes(email));
      if (!belongsToCustomer) continue;
      let body: string;
      try {
        body = JSON.stringify(redactPii(JSON.parse(raw)));
      } catch {
        body = JSON.stringify({ erased: true, customer: erasedCustomerRecord(customerId) });
      }
      await objectStore.putObject(DOCUMENT_BUCKET, objectKey, body, Buffer.byteLength(body), {
        'Content-Type': 'application/json',
      });
      await transaction(async (client) => {
        await this.repository.updateDocumentChecksum(
          client, objectKey, createHash('sha256').update(body).digest('hex'),
        );
      });
    }
  }

  private async readObject(objectKey: string): Promise<string | undefined> {
    try {
      const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'NoSuchKey' || code === 'NotFound') return undefined;
      throw error;
    }
  }
}
