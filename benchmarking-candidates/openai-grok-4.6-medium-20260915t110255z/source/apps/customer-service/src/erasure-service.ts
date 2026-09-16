import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { v4 as uuid } from 'uuid';
import { config } from '../../../packages/config/src/index.js';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import { completeIdempotency, requestHash, reserveIdempotency } from '../../../packages/operations/src/idempotency.js';
import {
  mapErasureError,
  redactPii,
  toPublicErasureRequest,
  type PublicErasureRequest,
} from '../../../packages/privacy/src/redaction.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { ErasureRepository } from './erasure-repository.js';

const IDEMPOTENCY_SCOPE = 'create-erasure';

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  async create(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<{ status: number; body: PublicErasureRequest }> {
    const hash = requestHash({ customerId });
    return transaction(async (client) => {
      const replay = await reserveIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, hash);
      const customer = await this.repository.findCustomer(client, merchantId, customerId);
      if (!customer) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });

      const existing = await this.repository.findByCustomer(client, customerId);
      const request = existing
        ? existing.status === 'failed' ? await this.repository.requeueFailed(client, existing) : existing
        : await this.repository.createRequest(client, merchantId, customerId);
      const body = toPublicErasureRequest(request);
      if (replay) return { status: replay.status, body };
      await completeIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, 202, body);
      return { status: 202, body };
    });
  }

  async get(merchantId: string, requestId: string): Promise<PublicErasureRequest | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? toPublicErasureRequest(row) : undefined;
  }

  async execute(requestId: string, merchantId: string, customerId: string): Promise<void> {
    const request = await this.repository.markProcessing(requestId);
    if (!request) throw new Error('erasure_request_missing');
    if (request.status === 'completed') return;

    const context = await this.repository.collectContext(merchantId, customerId);
    await this.purgeExternalStores(merchantId, customerId, context);

    await transaction(async (client) => {
      await this.repository.applyRelationalErasure(client, merchantId, customerId);
      await addOutboxEvent(client, {
        eventType: EVENT_TYPES.CUSTOMER_ERASED,
        aggregateType: 'customer',
        aggregateId: customerId,
        merchantId,
        correlationId: uuid(),
        payload: { customerId, erasureRequestId: requestId },
      });
      await this.repository.markCompleted(client, requestId);
    });
  }

  async markFailed(requestId: string, error: unknown): Promise<void> {
    await this.repository.markFailed(requestId, mapErasureError(error));
  }

  private async purgeExternalStores(
    merchantId: string,
    customerId: string,
    context: { emails: string[]; importKeys: string[]; documentKeys: Array<{ objectKey: string; documentType: string }> },
  ): Promise<void> {
    await this.deleteSearchDocument(merchantId, customerId);
    await this.deleteCache(merchantId, customerId);
    for (const email of context.emails) {
      await deleteMailpitMessagesForRecipient(email);
    }
    for (const document of context.documentKeys) {
      if (document.documentType === 'customer_import') {
        await this.deleteStoredObject(document.objectKey);
        await this.repository.deleteImportRecord(document.objectKey);
        continue;
      }
      await this.rewriteStoredDocument(document.objectKey, customerId);
    }
    for (const objectKey of context.importKeys) {
      if (await this.importBelongsToCustomer(objectKey, customerId, context.emails)) {
        await this.deleteStoredObject(objectKey);
        await this.repository.deleteImportRecord(objectKey);
      }
    }
  }

  private async deleteSearchDocument(merchantId: string, customerId: string): Promise<void> {
    try {
      await searchClient.delete({
        index: CUSTOMER_INDEX,
        id: `${merchantId}:${customerId}`,
        refresh: true,
      }, { ignore: [404] });
    } catch (error) {
      throw Object.assign(new Error('search_index_unavailable'), { cause: error });
    }
  }

  private async deleteCache(merchantId: string, customerId: string): Promise<void> {
    const redis = new Redis(config().REDIS_URL);
    try {
      await redis.del(
        `merchant:${merchantId}:customer:${customerId}`,
        `merchant:${merchantId}:customer:${customerId}:activity`,
      );
    } catch (error) {
      throw Object.assign(new Error('cache_unavailable'), { cause: error });
    } finally {
      redis.disconnect();
    }
  }

  private async rewriteStoredDocument(objectKey: string, customerId: string): Promise<void> {
    const raw = await this.readObject(objectKey);
    if (raw === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.deleteStoredObject(objectKey);
      return;
    }
    const redacted = redactPii(parsed);
    if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
      const document = redacted as Record<string, unknown>;
      if (document.customer && typeof document.customer === 'object') {
        document.customer = { id: customerId, status: 'erased' };
      }
    }
    const body = JSON.stringify(redacted);
    try {
      await objectStore.putObject(DOCUMENT_BUCKET, objectKey, body, Buffer.byteLength(body), {
        'Content-Type': 'application/json',
      });
    } catch (error) {
      throw Object.assign(new Error('object_store_unavailable'), { cause: error });
    }
    await this.repository.updateDocumentChecksum(objectKey, createHash('sha256').update(body).digest('hex'));
  }

  private async importBelongsToCustomer(objectKey: string, customerId: string, emails: string[]): Promise<boolean> {
    const raw = await this.readObject(objectKey);
    if (raw === undefined) return false;
    if (raw.includes(customerId)) return true;
    return emails.some((email) => raw.includes(email));
  }

  private async readObject(objectKey: string): Promise<string | undefined> {
    try {
      const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'NotFound' || code === 'NoSuchKey') return undefined;
      throw Object.assign(new Error('object_store_unavailable'), { cause: error });
    }
  }

  private async deleteStoredObject(objectKey: string): Promise<void> {
    try {
      await objectStore.removeObject(DOCUMENT_BUCKET, objectKey);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'NotFound' || code === 'NoSuchKey') return;
      throw Object.assign(new Error('object_store_unavailable'), { cause: error });
    }
  }
}
