import { randomUUID } from 'node:crypto';
import { logger } from '../../../packages/observability/src/logger.js';
import { boundedExponentialBackoffSeconds } from '../../../packages/operations/src/retry-policy.js';
import { ErasureRepository } from './erasure-repository.js';
import { ErasureService } from './erasure-service.js';

/** Runs accepted deletion requests, recovering leases left behind by a restart. */
export async function startErasureWorker(
  signal: AbortSignal,
  service = new ErasureService(),
  repository = new ErasureRepository(),
): Promise<void> {
  const workerId = `customer-service-erasure-${randomUUID()}`;
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
        await service.erase(request);
      } catch (error) {
        logger.error({ err: error, requestId: request.id }, 'customer erasure attempt failed');
        await repository.markFailed(
          request.id, service.stepErrorCode(error), boundedExponentialBackoffSeconds(request.attempts),
        );
      }
    } catch (error) {
      logger.error({ err: error }, 'erasure worker dependency unavailable');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  await service.close();
}
