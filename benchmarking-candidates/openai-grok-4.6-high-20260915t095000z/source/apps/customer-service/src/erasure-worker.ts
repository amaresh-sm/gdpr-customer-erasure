import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { erasureErrorCode, importContainsCustomer, redactDocumentCustomer } from './erasure-policy.js';
import { ErasureRepository, type ClaimedErasureRequest } from './erasure-repository.js';

const redis = new Redis(config().REDIS_URL);

export async function startErasureWorker(signal: AbortSignal): Promise<void> {
  const repository = new ErasureRepository();
  const workerId = `erasure-worker-${randomUUID()}`;
  let lastLeaseRecovery = 0;
  logger.info({ workerId }, 'erasure worker started');

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
        await processErasure(repository, request);
      } catch (error) {
        const code = erasureErrorCode(error);
        logger.error({ error, requestId: request.id, code }, 'erasure request failed');
        await repository.fail(request, code);
      }
    } catch (error) {
      logger.error({ error }, 'erasure worker loop failed');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  await redis.quit();
}

async function processErasure(repository: ErasureRepository, request: ClaimedErasureRequest): Promise<void> {
  const { merchant_id: merchantId, customer_id: customerId } = request;

  const emails = await transaction(async (client) => {
    return repository.rememberSubjectEmails(client, merchantId, customerId, request.id);
  });

  await redactSearchAndCache(merchantId, customerId);
  await redactStoredDocuments(repository, merchantId, customerId, emails);
  await redactNotifications(emails);

  await transaction(async (client) => {
    await repository.redactCustomerRecord(client, merchantId, customerId);
    await repository.redactSupport(client, merchantId, customerId);
    await repository.redactFinancialRecords(client, merchantId, customerId);
    await repository.redactOperationalRecords(client, merchantId, customerId);
  });

  await redactStoredDocuments(repository, merchantId, customerId, emails);
  await redactSearchAndCache(merchantId, customerId);

  await transaction(async (client) => {
    await repository.complete(client, request.id);
  });
}

async function redactSearchAndCache(merchantId: string, customerId: string): Promise<void> {
  const documentId = `${merchantId}:${customerId}`;
  try {
    await searchClient.delete({ index: CUSTOMER_INDEX, id: documentId, refresh: true });
  } catch (error) {
    const status = (error as { meta?: { statusCode?: number } }).meta?.statusCode;
    const message = error instanceof Error ? error.message : String(error);
    if (status !== 404 && !/not_found|index_not_found/i.test(message)) {
      throw Object.assign(new Error('search_unavailable'), { cause: error });
    }
  }

  const cacheKey = `merchant:${merchantId}:customer:${customerId}`;
  try {
    await redis.del(cacheKey, `${cacheKey}:activity`);
  } catch (error) {
    throw Object.assign(new Error('cache_unavailable'), { cause: error });
  }
}

async function redactStoredDocuments(
  repository: ErasureRepository,
  merchantId: string,
  customerId: string,
  emails: string[],
): Promise<void> {
  const documents = await transaction(async (client) => repository.listDocumentKeys(client, merchantId, customerId));
  for (const document of documents) {
    if (document.documentType === 'customer_import') continue;
    await redactObject(document.objectKey, customerId);
  }

  const imports = await transaction(async (client) => repository.listImportArtifacts(client, merchantId));
  for (const artifact of imports) {
    const content = await readObject(artifact.objectKey);
    if (content === undefined) {
      await transaction(async (client) => repository.deleteImport(client, merchantId, artifact.id, artifact.objectKey));
      continue;
    }
    if (!importContainsCustomer(content, customerId, emails)) continue;
    await removeObject(artifact.objectKey);
    await transaction(async (client) => repository.deleteImport(client, merchantId, artifact.id, artifact.objectKey));
  }
}

async function redactNotifications(emails: string[]): Promise<void> {
  for (const email of emails) {
    if (!email.includes('@') || email.endsWith('@erased.invalid') || email === 'erased') continue;
    try {
      await deleteMailpitMessagesForRecipient(email);
    } catch (error) {
      throw Object.assign(new Error('notification_store_unavailable'), { cause: error });
    }
  }
}

async function redactObject(objectKey: string, customerId: string): Promise<void> {
  const content = await readObject(objectKey);
  if (content === undefined) return;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const redacted = JSON.stringify(redactDocumentCustomer(parsed, customerId));
    await objectStore.putObject(DOCUMENT_BUCKET, objectKey, redacted, Buffer.byteLength(redacted), {
      'Content-Type': 'application/json',
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      await removeObject(objectKey);
      return;
    }
    throw Object.assign(new Error('document_store_unavailable'), { cause: error });
  }
}

async function readObject(objectKey: string): Promise<string | undefined> {
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'NoSuchKey' || code === 'NotFound') return undefined;
    throw Object.assign(new Error('document_store_unavailable'), { cause: error });
  }
}

async function removeObject(objectKey: string): Promise<void> {
  try {
    await objectStore.removeObject(DOCUMENT_BUCKET, objectKey);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'NoSuchKey' || code === 'NotFound') return;
    throw Object.assign(new Error('document_store_unavailable'), { cause: error });
  }
}
