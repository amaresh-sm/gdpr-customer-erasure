import { Redis } from 'ioredis';
import { config } from '../../config/src/index.js';
import { deleteMailpitMessagesForRecipient } from '../../notifications/src/mailpit.js';
import { CUSTOMER_INDEX, searchClient } from '../../search/src/client.js';
import { DOCUMENT_BUCKET, objectStore } from '../../storage/src/minio.js';

let redisClient: Redis | undefined;

function redis(): Redis {
  redisClient ??= new Redis(config().REDIS_URL, { maxRetriesPerRequest: 3 });
  return redisClient;
}

export async function closePrivacyRedis(): Promise<void> {
  if (!redisClient) return;
  await redisClient.quit();
  redisClient = undefined;
}

/** Drops the cached customer profile and activity projections held in Redis. */
export async function deleteCachedProjections(merchantId: string, customerId: string): Promise<void> {
  const key = `merchant:${merchantId}:customer:${customerId}`;
  await redis().del(key, `${key}:activity`);
}

function isMissingSearchTarget(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | undefined)?.statusCode;
  return status === 404;
}

/** Removes the searchable customer document, including any duplicate indexed copies. */
export async function deleteSearchDocuments(merchantId: string, customerId: string): Promise<void> {
  try {
    await searchClient.delete({ index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}`, refresh: true });
  } catch (error) {
    if (!isMissingSearchTarget(error)) throw error;
  }
  try {
    await searchClient.deleteByQuery({
      index: CUSTOMER_INDEX,
      refresh: true,
      body: { query: { bool: { filter: [{ term: { merchantId } }, { term: { customerId } }] } } },
    });
  } catch (error) {
    if (!isMissingSearchTarget(error)) throw error;
  }
}

/** Deletes provider-captured outbound mail addressed to the erased subject. */
export async function deleteCapturedEmails(destinations: string[]): Promise<void> {
  for (const destination of new Set(destinations.filter((value) => value.includes('@')))) {
    await deleteMailpitMessagesForRecipient(destination);
  }
}

export async function readStoredDocument(objectKey: string): Promise<string | undefined> {
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'NoSuchKey') return undefined;
    throw error;
  }
}

export async function writeStoredDocument(objectKey: string, body: string): Promise<void> {
  await objectStore.putObject(DOCUMENT_BUCKET, objectKey, body, Buffer.byteLength(body), {
    'Content-Type': 'application/json',
  });
}

export async function deleteStoredDocument(objectKey: string): Promise<void> {
  await objectStore.removeObject(DOCUMENT_BUCKET, objectKey);
}
