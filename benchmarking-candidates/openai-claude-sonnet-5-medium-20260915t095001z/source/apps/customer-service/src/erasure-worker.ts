import { randomUUID } from 'node:crypto';
import { transaction } from '../../../packages/database/src/pool.js';
import { logger } from '../../../packages/observability/src/logger.js';
import {
  claimJob,
  completeJob,
  failJob,
  recoverExpiredJobLeases,
  type ClaimedJob,
} from '../../../packages/operations/src/job-lifecycle.js';
import { CustomerNotFoundForErasureError, eraseCustomerData } from './erasure-executor.js';
import { ErasureRepository } from './erasure-repository.js';

export const ERASURE_QUEUE = 'privacy-erasure';

type ErasureJobPayload = { requestId: string; merchantId: string; customerId: string };

const repository = new ErasureRepository();

/** Maps failures to a stable, customer-data-free error code safe to expose via the status API. */
function errorCode(error: unknown): string {
  if (error instanceof CustomerNotFoundForErasureError) return 'customer_not_found';
  return 'erasure_processing_failed';
}

async function processOne(job: ClaimedJob<ErasureJobPayload>): Promise<void> {
  await transaction(async (client) => {
    await repository.markProcessing(client, job.payload.requestId);
  });
  try {
    await transaction(async (client) => {
      await eraseCustomerData(client, job.payload.merchantId, job.payload.customerId);
      await repository.markCompleted(client, job.payload.requestId);
      await completeJob(client, job);
    });
  } catch (error) {
    await transaction(async (client) => {
      await repository.markFailed(client, job.payload.requestId, errorCode(error));
      await failJob(client, job, error);
    });
  }
}

export async function runErasureWorker(signal: AbortSignal): Promise<void> {
  const workerId = `erasure-worker-${randomUUID()}`;
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastLeaseRecovery > 30_000) {
      await recoverExpiredJobLeases(ERASURE_QUEUE);
      lastLeaseRecovery = Date.now();
    }
    const job = await claimJob<ErasureJobPayload>(ERASURE_QUEUE, workerId);
    if (!job) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try {
      await processOne(job);
    } catch (error) {
      logger.error({ error, jobId: job.id }, 'erasure job failed unexpectedly');
    }
  }
}
