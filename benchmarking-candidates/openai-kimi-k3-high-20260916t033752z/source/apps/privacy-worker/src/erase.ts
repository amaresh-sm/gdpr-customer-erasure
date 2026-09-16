import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { transaction } from '../../../packages/database/src/pool.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';
import { ERASED_CUSTOMER_TOMBSTONE, type ErasureRequestRecord } from '../../../packages/privacy/src/redact.js';
import { ErasureWorkerRepository, type CustomerIdentity } from './repository.js';

/** Stable error codes surfaced as lastError; they never contain customer data. */
export class ErasureStepError extends Error {
  constructor(readonly code: string, options?: { cause?: unknown }) {
    super(code, options);
  }
}

interface StoredObject {
  name: string;
  lastModified: Date;
}

async function listStoredObjects(prefix: string): Promise<StoredObject[]> {
  return new Promise((resolve, reject) => {
    const items: StoredObject[] = [];
    const stream = objectStore.listObjectsV2(DOCUMENT_BUCKET, prefix, true);
    stream.on('data', (item: { name?: string; lastModified?: Date }) => {
      if (item.name) items.push({ name: item.name, lastModified: item.lastModified ?? new Date(0) });
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(items));
  });
}

async function readStoredObject(name: string): Promise<string> {
  const stream = await objectStore.getObject(DOCUMENT_BUCKET, name);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export class ErasureWorkflow {
  constructor(
    private readonly repository: ErasureWorkerRepository,
    private readonly redis: Redis,
  ) {}

  async run(request: ErasureRequestRecord, workerId: string): Promise<void> {
    const { merchant_id: merchantId, customer_id: customerId } = request;
    const identity = await this.repository.customerIdentifiers(merchantId, customerId);

    let importObjectKeys: string[];
    try {
      importObjectKeys = await this.findCustomerImportObjects(merchantId, customerId, identity);
    } catch (error) {
      throw new ErasureStepError('erasure_storage_scan_failed', { cause: error });
    }

    try {
      await transaction(async (client) => (
        this.repository.scrubCustomerData(client, merchantId, customerId, importObjectKeys)
      ));
    } catch (error) {
      throw new ErasureStepError('erasure_database_step_failed', { cause: error });
    }

    try {
      await this.removeImportObjects(merchantId, importObjectKeys);
      await this.redactRetainedDocuments(merchantId, customerId);
    } catch (error) {
      throw new ErasureStepError('erasure_storage_step_failed', { cause: error });
    }

    try {
      await this.purgeProjections(merchantId, customerId);
    } catch (error) {
      throw new ErasureStepError('erasure_projection_step_failed', { cause: error });
    }

    await this.repository.complete(request.id, workerId);
  }

  /** Import artifacts are matched by content so raw uploaded records do not retain PII. */
  private async findCustomerImportObjects(
    merchantId: string,
    customerId: string,
    identity: CustomerIdentity | undefined,
  ): Promise<string[]> {
    await ensureBucket();
    const identifiers = [customerId, identity?.email, identity?.external_reference]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const matches: string[] = [];
    for (const item of await listStoredObjects(`${merchantId}/imports/`)) {
      const content = await readStoredObject(item.name);
      if (identifiers.some((identifier) => content.includes(identifier))) matches.push(item.name);
    }
    return matches;
  }

  private async removeImportObjects(merchantId: string, matchedKeys: string[]): Promise<void> {
    await ensureBucket();
    for (const key of matchedKeys) {
      await objectStore.removeObject(DOCUMENT_BUCKET, key);
    }
    // Self-healing sweep: an earlier attempt may have removed manifests without
    // deleting the object. Only sweep objects old enough to not race fresh uploads.
    for (const item of await listStoredObjects(`${merchantId}/imports/`)) {
      if (Date.now() - item.lastModified.getTime() < 120_000) continue;
      if (!await this.repository.manifestExists(item.name)) {
        await objectStore.removeObject(DOCUMENT_BUCKET, item.name);
      }
    }
  }

  /** Retained receipts and invoices keep their financial content but lose the customer. */
  private async redactRetainedDocuments(merchantId: string, customerId: string): Promise<void> {
    await ensureBucket();
    for (const key of await this.repository.listRetainedDocumentKeys(merchantId, customerId)) {
      const parsed = JSON.parse(await readStoredObject(key)) as Record<string, unknown>;
      let redacted = false;
      for (const field of ['customer', 'customerSnapshot']) {
        if (field in parsed) {
          parsed[field] = ERASED_CUSTOMER_TOMBSTONE;
          redacted = true;
        }
      }
      if (!redacted) continue;
      const body = JSON.stringify(parsed);
      await objectStore.putObject(DOCUMENT_BUCKET, key, body, Buffer.byteLength(body), { 'Content-Type': 'application/json' });
      await this.repository.updateManifestChecksum(key, createHash('sha256').update(body).digest('hex'));
    }
  }

  /** Projections keep a PII-free tombstone so cached copies can no longer identify the customer. */
  private async purgeProjections(merchantId: string, customerId: string): Promise<void> {
    const cacheKey = `merchant:${merchantId}:customer:${customerId}`;
    await this.redis.set(cacheKey, JSON.stringify({ merchantId, customerId, erased: true }), 'EX', 3600);
    await this.redis.del(`${cacheKey}:activity`);
    await searchClient.index({
      index: CUSTOMER_INDEX,
      id: `${merchantId}:${customerId}`,
      body: { merchantId, customerId, erased: true, updatedAt: new Date().toISOString() },
      refresh: true,
    });
  }
}
