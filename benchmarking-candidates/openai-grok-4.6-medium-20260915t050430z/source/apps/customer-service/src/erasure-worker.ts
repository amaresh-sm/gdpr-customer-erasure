import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { anonymizedCustomerSnapshot, stripPii } from '../../../packages/privacy/src/redact.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { ErasureRepository, type ClaimedErasureRequest } from './erasure-repository.js';

const ERROR_CODES = {
  document_cleanup_failed: 'document_cleanup_failed',
  projection_cleanup_failed: 'projection_cleanup_failed',
  mailbox_cleanup_failed: 'mailbox_cleanup_failed',
  operational_cleanup_failed: 'operational_cleanup_failed',
} as const;

export function startErasureWorker(signal: AbortSignal, workerId = `erasure-worker-${crypto.randomUUID()}`): void {
  const repository = new ErasureRepository();
  const redis = new Redis(config().REDIS_URL);
  void run(signal, workerId, repository, redis);
}

async function run(
  signal: AbortSignal,
  workerId: string,
  repository: ErasureRepository,
  redis: Redis,
): Promise<void> {
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
        const code = error instanceof ErasureStepError ? error.code : ERROR_CODES.operational_cleanup_failed;
        logger.error({ error, requestId: request.id, code }, 'customer erasure failed');
        await repository.fail(request, code);
      }
    } catch (error) {
      logger.error({ error }, 'erasure worker loop failed');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  await redis.quit();
}

class ErasureStepError extends Error {
  constructor(readonly code: string, cause?: unknown) {
    super(code, { cause });
  }
}

async function processRequest(
  repository: ErasureRepository,
  redis: Redis,
  request: ClaimedErasureRequest,
): Promise<void> {
  const destinations = [...new Set([
    ...(request.pii_targets.destinations ?? []),
    request.pii_targets.email ?? '',
  ].filter(Boolean))];

  let importIds = request.pii_targets.importIds ?? [];
  try {
    await redactStoredDocuments(repository, request);
    const discovered = await deleteCustomerImportObjects(repository, request);
    importIds = [...new Set([...importIds, ...discovered])];
  } catch (error) {
    throw new ErasureStepError(ERROR_CODES.document_cleanup_failed, error);
  }
  try {
    await purgeProjections(redis, request);
  } catch (error) {
    throw new ErasureStepError(ERROR_CODES.projection_cleanup_failed, error);
  }
  try {
    for (const destination of destinations) {
      await deleteMailpitMessagesForRecipient(destination);
    }
  } catch (error) {
    throw new ErasureStepError(ERROR_CODES.mailbox_cleanup_failed, error);
  }

  await transaction(async (client) => {
    await repository.eraseOperationalRecords(client, request.merchant_id, request.customer_id);
    await repository.deleteImportArtifacts(client, request.merchant_id, importIds);
    await repository.complete(client, request);
    await addOutboxEvent(client, {
      eventType: EVENT_TYPES.CUSTOMER_ERASED,
      aggregateType: 'customer',
      aggregateId: request.customer_id,
      merchantId: request.merchant_id,
      correlationId: request.id,
      payload: { customerId: request.customer_id, requestId: request.id, erased: true },
    });
  });
}

async function redactStoredDocuments(repository: ErasureRepository, request: ClaimedErasureRequest): Promise<void> {
  const documents = await repository.listCustomerDocuments(request.merchant_id, request.customer_id);
  for (const document of documents) {
    if (document.document_type === 'customer_import') continue;
    const body = await rewriteObject(document.object_key, request.customer_id);
    if (!body) continue;
    await transaction(async (client) => {
      await repository.updateDocumentChecksum(client, document.object_key, createHash('sha256').update(body).digest('hex'));
    });
  }
}

async function rewriteObject(objectKey: string, customerId: string): Promise<string | undefined> {
  let current: string;
  try {
    current = await readObject(objectKey);
  } catch {
    return undefined;
  }
  let rewritten: unknown;
  try {
    rewritten = stripPii(JSON.parse(current));
    if (rewritten && typeof rewritten === 'object' && !Array.isArray(rewritten)) {
      const record = rewritten as Record<string, unknown>;
      record.customer = anonymizedCustomerSnapshot(customerId);
      record.erased = true;
    }
  } catch {
    rewritten = { erased: true, customer: anonymizedCustomerSnapshot(customerId) };
  }
  const body = JSON.stringify(rewritten);
  await objectStore.putObject(DOCUMENT_BUCKET, objectKey, body, Buffer.byteLength(body), {
    'Content-Type': 'application/json',
  });
  return body;
}

async function readObject(objectKey: string): Promise<string> {
  const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function deleteCustomerImportObjects(
  repository: ErasureRepository,
  request: ClaimedErasureRequest,
): Promise<string[]> {
  const artifacts = await repository.listImportArtifacts(request.merchant_id);
  const matched: string[] = [];
  for (const artifact of artifacts) {
    let belongs = false;
    try {
      const content = await readObject(artifact.object_key);
      belongs = content.includes(request.customer_id)
        || Boolean(request.pii_targets.email && content.includes(request.pii_targets.email));
    } catch {
      belongs = false;
    }
    if (!belongs) continue;
    matched.push(artifact.id);
    try {
      await objectStore.removeObject(DOCUMENT_BUCKET, artifact.object_key);
    } catch {
      // Already removed on a previous attempt.
    }
  }
  return matched;
}

async function purgeProjections(redis: Redis, request: ClaimedErasureRequest): Promise<void> {
  const cacheKey = `merchant:${request.merchant_id}:customer:${request.customer_id}`;
  await redis.del(cacheKey, `${cacheKey}:activity`);
  try {
    await searchClient.delete({
      index: CUSTOMER_INDEX,
      id: `${request.merchant_id}:${request.customer_id}`,
      refresh: true,
    });
  } catch (error) {
    const status = (error as { meta?: { statusCode?: number }; statusCode?: number }).meta?.statusCode
      ?? (error as { statusCode?: number }).statusCode;
    if (status !== 404) throw error;
  }
}
