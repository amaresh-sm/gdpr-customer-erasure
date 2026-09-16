import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { nextRetryDelaySeconds } from '../../../packages/operations/src/job-lifecycle.js';
import { type ErasureRequestRow } from '../../../packages/privacy/src/erasure-contract.js';
import { anonymizedProjection, redactJson, uniqueStrings } from '../../../packages/privacy/src/redact.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { ErasureRepository, type CustomerIdentifiers, type StoredObject } from './erasure-repository.js';

const STABLE_ERRORS = {
  cleanup_failed: 'cleanup_failed',
  verification_failed: 'verification_failed',
  search_unavailable: 'search_unavailable',
  storage_unavailable: 'storage_unavailable',
  mail_unavailable: 'mail_unavailable',
} as const;

export class ErasureWorker {
  private lastLeaseRecovery = 0;

  constructor(
    private readonly repository = new ErasureRepository(),
    private readonly redis = new Redis(config().REDIS_URL),
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (Date.now() - this.lastLeaseRecovery > 30_000) {
        await this.repository.recoverExpiredLeases();
        this.lastLeaseRecovery = Date.now();
      }
      const request = await this.repository.claim(`erasure-worker-${process.pid}`);
      if (!request) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      try {
        await this.process(request);
        await this.repository.markCompleted(request.id);
      } catch (error) {
        const code = errorCode(error);
        logger.error({ error, requestId: request.id, code }, 'erasure request failed');
        await this.repository.markFailed(request.id, code, nextRetryDelaySeconds(request.attempts));
      }
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private async process(request: ErasureRequestRow): Promise<void> {
    const { merchant_id: merchantId, customer_id: customerId } = request;
    await transaction(async (client) => {
      const created = await this.repository.insertTombstone(client, merchantId, customerId, request.id);
      if (created) {
        await addOutboxEvent(client, {
          eventType: EVENT_TYPES.CUSTOMER_ERASED,
          aggregateType: 'customer',
          aggregateId: customerId,
          merchantId,
          correlationId: uuid(),
          payload: { customerId },
        });
      }
    });

    const identifiers = await this.subjectIdentifiers(request, merchantId, customerId);
    await this.deleteCapturedMail(identifiers.emails);

    await transaction(async (client) => {
      await this.repository.anonymizeCustomer(client, merchantId, customerId);
      await this.repository.deletePersonalRecords(client, merchantId, customerId);
      await this.repository.redactFinancialRecords(client, merchantId, customerId, redactJson);
      await this.repository.redactOperationalRecords(client, merchantId, customerId, identifiers.emails, redactJson);
    });

    const objects = await this.repository.listStoredObjects(merchantId, customerId);
    await this.cleanupStoredObjects(merchantId, customerId, objects, identifiers);

    await this.anonymizeSearchDocument(merchantId, customerId);
    await this.anonymizeCache(merchantId, customerId);
    await this.deleteCapturedMail(identifiers.emails);

    const leftovers = await this.repository.remainingPersonalData(merchantId, customerId, identifiers);
    leftovers.push(...await this.remainingProjectedData(merchantId, customerId, identifiers));
    leftovers.push(...await this.remainingStoredPii(objects, identifiers));
    if (leftovers.length) {
      throw Object.assign(new Error(STABLE_ERRORS.verification_failed), { code: STABLE_ERRORS.verification_failed, leftovers });
    }
  }

  private async deleteCapturedMail(emails: string[]): Promise<void> {
    try {
      for (const email of uniqueStrings(emails).filter((value) => value.includes('@') && !value.endsWith('@invalid.example'))) {
        await deleteMailpitMessagesForRecipient(email);
      }
    } catch (error) {
      throw Object.assign(new Error(STABLE_ERRORS.mail_unavailable), { code: STABLE_ERRORS.mail_unavailable, cause: error });
    }
  }

  private async cleanupStoredObjects(
    merchantId: string,
    customerId: string,
    objects: StoredObject[],
    identifiers: CustomerIdentifiers,
  ): Promise<void> {
    for (const object of objects) {
      try {
        const raw = await readObject(object.objectKey);
        if (!mentionsIdentifiers(raw, customerId, identifiers)) continue;
        const rewritten = rewriteStoredDocument(raw);
        await objectStore.putObject(DOCUMENT_BUCKET, object.objectKey, rewritten, Buffer.byteLength(rewritten), {
          'Content-Type': 'application/json',
        });
        await transaction(async (client) => {
          await this.repository.updateManifestChecksum(
            client, merchantId, object.objectKey, createHash('sha256').update(rewritten).digest('hex'),
          );
        });
      } catch (error) {
        if (isMissingObject(error)) continue;
        throw Object.assign(new Error(STABLE_ERRORS.storage_unavailable), { code: STABLE_ERRORS.storage_unavailable, cause: error });
      }
    }
  }

  private async subjectIdentifiers(
    request: ErasureRequestRow,
    merchantId: string,
    customerId: string,
  ): Promise<CustomerIdentifiers> {
    const stored = await this.repository.loadIdentifiers(request.id);
    if (stored) return stored;
    const identifiers = await this.repository.collectIdentifiers(merchantId, customerId);
    await this.repository.saveIdentifiers(request.id, identifiers);
    return identifiers;
  }

  private async anonymizeSearchDocument(merchantId: string, customerId: string): Promise<void> {
    try {
      await searchClient.index({
        index: CUSTOMER_INDEX,
        id: `${merchantId}:${customerId}`,
        body: anonymizedProjection(merchantId, customerId),
        refresh: true,
      });
    } catch (error) {
      throw Object.assign(new Error(STABLE_ERRORS.search_unavailable), { code: STABLE_ERRORS.search_unavailable, cause: error });
    }
  }

  private async anonymizeCache(merchantId: string, customerId: string): Promise<void> {
    const key = `merchant:${merchantId}:customer:${customerId}`;
    await this.redis.set(key, JSON.stringify(anonymizedProjection(merchantId, customerId)), 'EX', 3600);
    await this.redis.del(`${key}:activity`);
  }

  private async remainingProjectedData(
    merchantId: string,
    customerId: string,
    identifiers: CustomerIdentifiers,
  ): Promise<string[]> {
    const leftovers: string[] = [];
    const cached = await this.redis.get(`merchant:${merchantId}:customer:${customerId}`);
    if (cached && mentionsOriginalPii(cached, identifiers)) leftovers.push('redis_projection');
    const activity = await this.redis.hgetall(`merchant:${merchantId}:customer:${customerId}:activity`);
    if (activity.customerEmail && mentionsOriginalPii(activity.customerEmail, identifiers)) {
      leftovers.push('redis_activity');
    }
    try {
      const document = await searchClient.get({ index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}` });
      const source = JSON.stringify((document.body as { _source?: unknown })._source ?? {});
      if (mentionsOriginalPii(source, identifiers)) leftovers.push('search_projection');
    } catch (error) {
      if (searchStatus(error) !== 404) leftovers.push('search_projection');
    }
    return leftovers;
  }

  private async remainingStoredPii(
    objects: StoredObject[],
    identifiers: CustomerIdentifiers,
  ): Promise<string[]> {
    const leftovers: string[] = [];
    for (const object of objects) {
      try {
        const raw = await readObject(object.objectKey);
        if (mentionsOriginalPii(raw, identifiers)) leftovers.push(`object:${object.documentType ?? object.objectKey}`);
      } catch (error) {
        if (!isMissingObject(error)) leftovers.push(`object:${object.documentType ?? object.objectKey}`);
      }
    }
    return leftovers;
  }
}

async function readObject(objectKey: string): Promise<string> {
  const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function rewriteStoredDocument(raw: string): string {
  try {
    return JSON.stringify(redactJson(JSON.parse(raw)));
  } catch {
    return JSON.stringify({ redacted: true });
  }
}

function mentionsIdentifiers(raw: string, customerId: string, identifiers: CustomerIdentifiers): boolean {
  const haystack = raw.toLowerCase();
  if (haystack.includes(customerId.toLowerCase())) return true;
  return mentionsOriginalPii(raw, identifiers);
}

function mentionsOriginalPii(raw: string, identifiers: CustomerIdentifiers): boolean {
  const haystack = raw.toLowerCase();
  return originalLookupValues(identifiers).some((value) => haystack.includes(value));
}

function originalLookupValues(identifiers: CustomerIdentifiers): string[] {
  return [...identifiers.emails, ...identifiers.names, ...identifiers.phones]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 2 && !value.endsWith('@invalid.example') && value !== 'redacted');
}

function isMissingObject(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate.code === 'NoSuchKey' || candidate.code === 'NotFound' || candidate.code === 'NotFoundError'
    || Boolean(candidate.message?.includes('The specified key does not exist'));
}

function searchStatus(error: unknown): number | undefined {
  const candidate = error as { statusCode?: number; meta?: { statusCode?: number } };
  return candidate.meta?.statusCode ?? candidate.statusCode;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0 && code.length <= 64 && !code.includes('@')) return code;
  return STABLE_ERRORS.cleanup_failed;
}
