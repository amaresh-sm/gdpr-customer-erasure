import { randomUUID } from 'node:crypto';
import { transaction } from '../../../packages/database/src/pool.js';
import { logger } from '../../../packages/observability/src/logger.js';
import {
  claimJob,
  completeJob,
  failJob,
  recoverExpiredJobLeases,
} from '../../../packages/operations/src/job-lifecycle.js';
import { ErasureService } from './erasure-service.js';

type ErasureJob = {
  requestId: string;
  merchantId: string;
  customerId: string;
};

export function startErasureWorker(signal: AbortSignal): void {
  const workerId = `erasure-worker-${randomUUID()}`;
  const service = new ErasureService();
  void run(signal, workerId, service);
}

async function run(signal: AbortSignal, workerId: string, service: ErasureService): Promise<void> {
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastLeaseRecovery > 30_000) {
      await recoverExpiredJobLeases('privacy');
      lastLeaseRecovery = Date.now();
    }
    const job = await claimJob<ErasureJob>('privacy', workerId, 120);
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    try {
      await service.execute(job.payload.requestId, job.payload.merchantId, job.payload.customerId);
      await transaction(async (client) => await completeJob(client, job));
    } catch (error) {
      logger.error({ error, jobId: job.id, requestId: job.payload.requestId }, 'customer erasure failed');
      await service.markFailed(job.payload.requestId, error);
      await transaction(async (client) => await failJob(client, job, error));
    }
  }
}
