import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { objectStore, DOCUMENT_BUCKET } from '../../../packages/storage/src/minio.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { claimJob, completeJob, failJob, recoverExpiredJobLeases, type ClaimedJob } from '../../../packages/operations/src/job-lifecycle.js';
import { ErasureRepository } from './repository.js';

process.env.SERVICE_NAME = 'erasure-worker';
type ErasureJob = { requestId: string; customerId: string };
const workerId = `erasure-worker-${randomUUID()}`;
const controller = new AbortController();
const repository = new ErasureRepository();
const redis = new Redis(process.env.REDIS_URL!);

async function erase(job: ClaimedJob<ErasureJob>): Promise<void> {
  const request = await repository.begin(job.payload.requestId, job.merchant_id);
  if (!request) {
    await transaction(async (client) => await completeJob(client, job));
    return;
  }
  try {
    await redis.del(`merchant:${job.merchant_id}:customer:${job.payload.customerId}`, `merchant:${job.merchant_id}:customer:${job.payload.customerId}:activity`);
    const searchId = `${job.merchant_id}:${job.payload.customerId}`;
    if ((await searchClient.exists({ index: CUSTOMER_INDEX, id: searchId })).body) await searchClient.delete({ index: CUSTOMER_INDEX, id: searchId });
    const objectKeys = await repository.objectKeys(job.merchant_id, job.payload.customerId);
    await Promise.all(objectKeys.map(async (objectKey) => await objectStore.removeObject(DOCUMENT_BUCKET, objectKey)));
    await repository.eraseDatabase(job.merchant_id, job.payload.customerId, job.payload.requestId);
    await transaction(async (client) => await completeJob(client, job));
  } catch (error) {
    await repository.fail(job.payload.requestId, job.merchant_id);
    throw error;
  }
}

async function run(signal: AbortSignal): Promise<void> {
  let lastRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastRecovery > 30_000) { await recoverExpiredJobLeases('privacy'); lastRecovery = Date.now(); }
    const job = await claimJob<ErasureJob>('privacy', workerId);
    if (!job) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try { await erase(job); }
    catch (error) {
      logger.error({ error, requestId: job.payload.requestId }, 'customer erasure failed');
      await transaction(async (client) => await failJob(client, job, error));
    }
  }
}

void run(controller.signal);
logger.info({ workerId }, 'erasure worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { controller.abort(); void redis.quit(); });
