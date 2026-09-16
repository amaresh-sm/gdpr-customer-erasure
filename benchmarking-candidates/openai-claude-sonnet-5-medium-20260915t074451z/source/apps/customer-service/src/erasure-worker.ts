import { randomUUID } from 'node:crypto';
import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureRepository } from './erasure-repository.js';
import { ErasureService } from './erasure-service.js';

/**
 * Processes accepted data deletion requests in the background so the request-creation endpoint
 * can respond immediately. Crash-recoverable via lease expiry, and retried with bounded backoff
 * on failure, matching the durable-job pattern used elsewhere in this codebase.
 */
export async function runErasureWorker(signal: AbortSignal): Promise<void> {
  const repository = new ErasureRepository();
  const service = new ErasureService(repository);
  const workerId = `customer-service-erasure-${randomUUID()}`;
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastLeaseRecovery > 30_000) {
      await repository.recoverExpiredLeases();
      lastLeaseRecovery = Date.now();
    }
    const job = await repository.claim(workerId);
    if (!job) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try {
      await service.process(job);
    } catch (error) {
      logger.error({ error, requestId: job.id }, 'erasure request processing failed');
      await repository.markFailed(job.id, job.attempts, 'erasure_processing_failed');
    }
  }
}
