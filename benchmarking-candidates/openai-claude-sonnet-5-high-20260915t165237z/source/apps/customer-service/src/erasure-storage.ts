import { Redis } from 'ioredis';
import { config } from '../../../packages/config/src/index.js';
import { redactCustomerPayload } from '../../../packages/operations/src/pii-redaction.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import type { DocumentToRedact } from './erasure-scrub-repository.js';

let redis: Redis | undefined;
function redisClient(): Redis {
  redis ??= new Redis(config().REDIS_URL);
  return redis;
}

/** Overwrites a stored receipt/invoice document with a redacted copy so retained financial documents no longer identify the customer. */
async function redactStoredObject(objectKey: string): Promise<void> {
  const chunks: Buffer[] = [];
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
    for await (const chunk of stream) chunks.push(chunk as Buffer);
  } catch (error) {
    if ((error as { code?: string }).code === 'NoSuchKey') return;
    throw error;
  }
  const original = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  const redacted = redactCustomerPayload(original);
  const body = JSON.stringify(redacted);
  await objectStore.putObject(DOCUMENT_BUCKET, objectKey, body, Buffer.byteLength(body), { 'Content-Type': 'application/json' });
}

export async function redactStoredDocuments(documents: DocumentToRedact[]): Promise<void> {
  for (const document of documents) await redactStoredObject(document.object_key);
}

/** Removes the customer's projections from the actively-served search index and cache. */
export async function purgeProjections(merchantId: string, customerId: string): Promise<void> {
  const client = redisClient();
  await client.del(`merchant:${merchantId}:customer:${customerId}`);
  await client.del(`merchant:${merchantId}:customer:${customerId}:activity`);
  try {
    await searchClient.delete({ index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}` });
  } catch (error) {
    const status = (error as { meta?: { statusCode?: number } }).meta?.statusCode;
    if (status !== 404) throw error;
  }
}

export async function closeErasureStorageClients(): Promise<void> {
  await redis?.quit();
}
