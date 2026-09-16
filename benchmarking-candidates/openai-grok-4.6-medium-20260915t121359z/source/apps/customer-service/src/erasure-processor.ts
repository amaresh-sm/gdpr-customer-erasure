import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { anonymizedCustomerSnapshot, erasedEmail, erasureErrorCode, redactJson } from '../../../packages/privacy/src/redaction.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { ErasureRepository, type ErasureRequestRow } from './erasure-repository.js';

const workerId = `erasure-worker-${randomUUID()}`;

export function startErasureProcessor(signal: AbortSignal, repository = new ErasureRepository()): void {
  const redis = new Redis(config().REDIS_URL);
  void run(signal, repository, redis);
}

async function run(signal: AbortSignal, repository: ErasureRepository, redis: Redis): Promise<void> {
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() - lastLeaseRecovery > 30_000) {
        await repository.recoverExpiredLeases();
        lastLeaseRecovery = Date.now();
      }
      const request = await repository.claim(workerId);
      if (!request) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      try {
        await processRequest(repository, redis, request);
      } catch (error) {
        logger.error({ error, requestId: request.id }, 'erasure request failed');
        await repository.fail(request, erasureErrorCode(error));
      }
    } catch (error) {
      logger.error({ error }, 'erasure processor loop failed');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  await redis.quit();
}

async function processRequest(repository: ErasureRepository, redis: Redis, request: ErasureRequestRow): Promise<void> {
  const destinations = await repository.collectDestinations(request.merchant_id, request.customer_id);
  for (const destination of destinations) {
    await deleteMailpitMessagesForRecipient(destination);
  }

  const documents = await repository.listCustomerDocuments(request.merchant_id, request.customer_id);
  for (const document of documents) {
    if (document.document_type === 'customer_import') {
      if (await importMentionsCustomer(document.object_key, request.customer_id)) {
        await rewriteImportDocument(document.object_key);
      }
      continue;
    }
    await rewriteFinancialDocument(document.object_key, request.customer_id);
  }

  await deleteSearchDocument(request.merchant_id, request.customer_id);
  await redis.del(
    `merchant:${request.merchant_id}:customer:${request.customer_id}`,
    `merchant:${request.merchant_id}:customer:${request.customer_id}:activity`,
  );

  await transaction(async (client) => {
    await repository.redactDatabase(client, request.merchant_id, request.customer_id, request.id);
    await addOutboxEvent(client, {
      eventType: EVENT_TYPES.CUSTOMER_ERASED,
      aggregateType: 'customer',
      aggregateId: request.customer_id,
      merchantId: request.merchant_id,
      correlationId: request.id,
      payload: { customerId: request.customer_id, requestId: request.id, status: 'completed' },
    });
    await repository.complete(client, request.id);
  });
}

async function importMentionsCustomer(objectKey: string, customerId: string): Promise<boolean> {
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return chunks.join('').includes(customerId);
  } catch (error) {
    if (isMissingObject(error)) return false;
    throw error;
  }
}

async function rewriteFinancialDocument(objectKey: string, customerId: string): Promise<void> {
  let existing: Record<string, unknown>;
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    existing = JSON.parse(chunks.join('')) as Record<string, unknown>;
  } catch (error) {
    if (isMissingObject(error)) return;
    throw error;
  }
  const rewritten = redactJson({
    ...existing,
    customer: anonymizedCustomerSnapshot(customerId),
    customerEmail: erasedEmail(customerId),
  }, customerId);
  const body = JSON.stringify(rewritten);
  await objectStore.putObject(DOCUMENT_BUCKET, objectKey, body, Buffer.byteLength(body), {
    'Content-Type': 'application/json',
  });
}

async function rewriteImportDocument(objectKey: string): Promise<void> {
  const body = JSON.stringify({ erased: true });
  await objectStore.putObject(DOCUMENT_BUCKET, objectKey, body, Buffer.byteLength(body), {
    'Content-Type': 'application/json',
  });
}

async function deleteSearchDocument(merchantId: string, customerId: string): Promise<void> {
  try {
    await searchClient.delete({ index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}`, refresh: true });
  } catch (error) {
    if (!isMissingSearchDocument(error)) throw error;
  }
  try {
    await searchClient.deleteByQuery({
      index: CUSTOMER_INDEX,
      refresh: true,
      body: { query: { term: { customerId } } },
    });
  } catch (error) {
    if (!isMissingSearchDocument(error)) throw error;
  }
}

function isMissingObject(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : String(error);
  return code === 'NotFound' || code === 'NoSuchKey' || message.includes('Not Found') || message.includes('does not exist');
}

function isMissingSearchDocument(error: unknown): boolean {
  const status = (error as { statusCode?: number; meta?: { statusCode?: number } }).statusCode
    ?? (error as { meta?: { statusCode?: number } }).meta?.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  return status === 404 || message.includes('not_found') || message.includes('index_not_found');
}
