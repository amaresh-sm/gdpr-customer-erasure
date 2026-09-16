import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { redactPii } from '../../../packages/privacy/src/redact.js';
import { lockCustomerPrivacy } from '../../../packages/privacy/src/tombstone.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { ErasureRepository, type ClaimedErasure } from './erasure-repository.js';

class CleanupError extends Error {
  constructor(readonly code: string, cause: unknown) {
    super(code, { cause });
  }
}

export function startErasureWorker(signal: AbortSignal): void {
  const repository = new ErasureRepository();
  const redis = new Redis(config().REDIS_URL);
  void run(signal, `erasure-${randomUUID()}`, repository, redis);
}

async function run(
  signal: AbortSignal,
  workerId: string,
  repository: ErasureRepository,
  redis: Redis,
): Promise<void> {
  let recoveredAt = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() - recoveredAt > 30_000) {
        await repository.recoverExpiredLeases();
        recoveredAt = Date.now();
      }
      const request = await repository.claim(workerId);
      if (!request) {
        await pause(250);
        continue;
      }
      try {
        await processRequest(repository, redis, request);
      } catch (error) {
        const code = error instanceof CleanupError ? error.code : 'database_cleanup_failed';
        logger.error({ error, requestId: request.id, code }, 'customer erasure failed');
        await repository.fail(request, code);
      }
    } catch (error) {
      logger.error({ error }, 'customer erasure worker loop failed');
      await pause(1_000);
    }
  }
  await redis.quit();
}

async function processRequest(
  repository: ErasureRepository,
  redis: Redis,
  request: ClaimedErasure,
): Promise<void> {
  const importKeys = await cleanupObjects(repository, request);
  await step('projection_cleanup_failed', async () => {
    const key = `merchant:${request.merchant_id}:customer:${request.customer_id}`;
    await redis.del(key, `${key}:activity`);
    try {
      await searchClient.delete({
        index: CUSTOMER_INDEX,
        id: `${request.merchant_id}:${request.customer_id}`,
        refresh: true,
      });
    } catch (error) {
      if (httpStatus(error) !== 404) throw error;
    }
  });
  await step('mailbox_cleanup_failed', async () => {
    for (const destination of request.cleanup_targets.destinations ?? []) {
      await deleteMailpitMessagesForRecipient(destination);
    }
  });

  await transaction(async (client) => {
    await lockCustomerPrivacy(client, request.merchant_id, request.customer_id);
    await repository.deleteImports(client, request.merchant_id, importKeys);
    await repository.eraseDatabase(client, request.merchant_id, request.customer_id, request.id);
    await repository.complete(client, request);
  });
}

async function cleanupObjects(
  repository: ErasureRepository,
  request: ClaimedErasure,
): Promise<string[]> {
  return await step('document_cleanup_failed', async () => {
    const exact = new Set(request.cleanup_targets.objectKeys ?? []);
    const imports = await repository.listImports(request.merchant_id);
    const matchedImports = new Set<string>();
    for (const artifact of imports) {
      if (exact.has(artifact.object_key) || await objectContainsIdentity(artifact.object_key, request)) {
        exact.add(artifact.object_key);
        matchedImports.add(artifact.object_key);
      }
    }
    for (const key of exact) {
      if (matchedImports.has(key)) {
        await removeObject(key);
      } else {
        await rewriteFinancialDocument(repository, key);
      }
    }
    return [...matchedImports];
  });
}

async function removeObject(key: string): Promise<void> {
  try {
    await objectStore.removeObject(DOCUMENT_BUCKET, key);
  } catch (error) {
    if (httpStatus(error) !== 404 && (error as { code?: string }).code !== 'NoSuchKey') throw error;
  }
}

async function rewriteFinancialDocument(repository: ErasureRepository, key: string): Promise<void> {
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    const body = JSON.stringify({ ...(redactPii(parsed) as Record<string, unknown>), customerErased: true });
    await objectStore.putObject(DOCUMENT_BUCKET, key, body, Buffer.byteLength(body), {
      'Content-Type': 'application/json',
    });
    await transaction(async (client) => await repository.updateDocumentChecksum(
      client,
      key,
      createHash('sha256').update(body).digest('hex'),
    ));
  } catch (error) {
    if (httpStatus(error) !== 404 && (error as { code?: string }).code !== 'NoSuchKey') throw error;
  }
}

async function objectContainsIdentity(objectKey: string, request: ClaimedErasure): Promise<boolean> {
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const content = Buffer.concat(chunks).toString('utf8');
    return [
      request.customer_id,
      request.cleanup_targets.email,
      ...(request.cleanup_targets.identityValues ?? []),
    ].some((value) => Boolean(value && content.includes(value)));
  } catch (error) {
    if (httpStatus(error) === 404 || (error as { code?: string }).code === 'NoSuchKey') return false;
    throw error;
  }
}

async function step<T>(code: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new CleanupError(code, error);
  }
}

function httpStatus(error: unknown): number | undefined {
  const candidate = error as { statusCode?: number; meta?: { statusCode?: number } };
  return candidate.meta?.statusCode ?? candidate.statusCode;
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
