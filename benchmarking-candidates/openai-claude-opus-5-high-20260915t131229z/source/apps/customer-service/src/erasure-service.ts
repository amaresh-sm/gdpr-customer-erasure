import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import { redactPii } from '../../../packages/privacy/src/redaction.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import {
  completeIdempotency,
  requestHash,
  reserveIdempotency,
} from '../../../packages/operations/src/idempotency.js';
import { ErasureRepository, type ErasureRequestRow } from './erasure-repository.js';

const IDEMPOTENCY_SCOPE = 'create-erasure-request';

/** Stable, customer-free error codes reported by a failed request. */
const STEP_ERRORS: Record<ErasureStep, string> = {
  search: 'search_cleanup_failed',
  cache: 'cache_cleanup_failed',
  documents: 'document_cleanup_failed',
  mail: 'mail_cleanup_failed',
  database: 'database_cleanup_failed',
};

export type ErasureStep = 'search' | 'cache' | 'documents' | 'mail' | 'database';

export interface ErasureRequestView {
  id: string;
  customerId: string;
  status: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export function serializeErasureRequest(row: ErasureRequestRow): ErasureRequestView {
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

class ErasureStepError extends Error {
  constructor(readonly step: ErasureStep, cause: unknown) {
    super(STEP_ERRORS[step], { cause });
  }
}

export class ErasureService {
  private redis: Redis | undefined;

  constructor(private readonly repository = new ErasureRepository()) {}

  /**
   * Accepts a deletion request for the customer. The same idempotency key always
   * resolves to the same request, and a customer never gets a second workflow.
   */
  async request(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
    correlationId = randomUUID(),
  ): Promise<{ status: number; body: ErasureRequestView }> {
    return await transaction(async (client) => {
      const existing = await this.repository.findByCustomer(client, merchantId, customerId);
      if (!existing && !await this.repository.customerExists(client, merchantId, customerId)) {
        throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });
      }
      const replay = await reserveIdempotency(
        client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, requestHash({ customerId }),
      );
      if (replay) return { status: replay.status, body: replay.body as ErasureRequestView };

      if (existing) {
        await this.repository.requeue(client, existing.id);
        const body = serializeErasureRequest(existing);
        await completeIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, 202, body);
        return { status: 202, body };
      }

      const created = await this.repository.create(client, merchantId, customerId);
      await this.repository.recordRequestedAudit(client, created, correlationId);
      const body = serializeErasureRequest(created);
      await completeIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, 202, body);
      return { status: 202, body };
    });
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequestView | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? serializeErasureRequest(row) : undefined;
  }

  /**
   * Erases the customer everywhere PayFlow stores personal data. Steps are
   * idempotent and recorded, so a retry after a crash resumes without repeating
   * finished work. The database step runs last and commits completion with it,
   * because the database is the source the remaining systems are rebuilt from.
   */
  async erase(request: ErasureRequestRow): Promise<void> {
    const done = await this.repository.completedSteps(request.id);
    const subject = await this.repository.describeSubject(request.merchant_id, request.customer_id);
    const steps: Array<[ErasureStep, () => Promise<void>]> = [
      ['search', () => this.purgeSearch(request)],
      ['cache', () => this.purgeCache(request)],
      ['documents', () => this.purgeDocuments(request, subject.documents)],
      ['mail', () => this.purgeMail(subject.emailDestinations)],
      ['database', () => this.repository.purgeDatabase(request)],
    ];
    for (const [step, run] of steps) {
      if (done.has(step)) continue;
      try {
        await run();
      } catch (error) {
        throw new ErasureStepError(step, error);
      }
      if (step !== 'database') await this.repository.markStepCompleted(request.id, step);
    }
  }

  stepErrorCode(error: unknown): string {
    return error instanceof ErasureStepError ? error.message : 'erasure_failed';
  }

  async close(): Promise<void> {
    if (this.redis) await this.redis.quit();
    this.redis = undefined;
  }

  private async purgeSearch(request: ErasureRequestRow): Promise<void> {
    try {
      await searchClient.deleteByQuery({
        index: CUSTOMER_INDEX,
        refresh: true,
        body: {
          query: {
            bool: {
              must: [
                { term: { merchantId: request.merchant_id } },
                { term: { customerId: request.customer_id } },
              ],
            },
          },
        },
      });
    } catch (error) {
      if (!isMissingSearchIndex(error)) throw error;
    }
  }

  private async purgeCache(request: ErasureRequestRow): Promise<void> {
    this.redis ??= new Redis(config().REDIS_URL);
    const key = `merchant:${request.merchant_id}:customer:${request.customer_id}`;
    await this.redis.del(key, `${key}:activity`);
  }

  /**
   * Retained financial documents keep their amounts and identifiers but lose the
   * customer's details; documents belonging to other customers are untouched.
   */
  private async purgeDocuments(
    request: ErasureRequestRow,
    documents: Array<{ objectKey: string; documentType: string }>,
  ): Promise<void> {
    for (const document of documents) {
      const original = await this.readObject(document.objectKey);
      if (original === undefined) continue;
      if (!original.includes(request.customer_id) && document.documentType === 'customer_import') continue;
      const redacted = JSON.stringify(redactPii(JSON.parse(original)));
      if (redacted === original) continue;
      await objectStore.putObject(DOCUMENT_BUCKET, document.objectKey, redacted, Buffer.byteLength(redacted), {
        'Content-Type': 'application/json',
      });
      await this.repository.updateDocumentChecksum(
        document.objectKey, createHash('sha256').update(redacted).digest('hex'),
      );
    }
  }

  private async purgeMail(destinations: string[]): Promise<void> {
    for (const destination of destinations) await deleteMailpitMessagesForRecipient(destination);
  }

  private async readObject(objectKey: string): Promise<string | undefined> {
    try {
      const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
  }
}

function isMissingSearchIndex(error: unknown): boolean {
  const candidate = error as { meta?: { statusCode?: number }; statusCode?: number };
  return candidate.meta?.statusCode === 404 || candidate.statusCode === 404;
}

function isMissingObject(error: unknown): boolean {
  const candidate = error as { code?: string };
  return candidate.code === 'NoSuchKey' || candidate.code === 'NotFound';
}
