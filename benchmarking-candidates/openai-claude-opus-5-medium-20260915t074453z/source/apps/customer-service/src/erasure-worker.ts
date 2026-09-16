import { randomUUID } from 'node:crypto';
import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureRequestRepository } from './erasure-request-repository.js';
import { ErasureService } from './erasure-service.js';

/**
 * Drains accepted deletion requests. Claims are leased, so a request left behind by a crashed or
 * restarted process becomes runnable again instead of stalling half-finished, and the recorded step
 * list means the next attempt resumes rather than redoing destructive work.
 */
export async function startErasureWorker(signal: AbortSignal): Promise<void> {
  const workerId = `customer-service-erasure-${randomUUID()}`;
  const requests = new ErasureRequestRepository();
  const service = new ErasureService(requests);
  let lastLeaseRecovery = 0;
  try {
    while (!signal.aborted) {
      try {
        if (Date.now() - lastLeaseRecovery > 30_000) {
          await requests.recoverExpiredLeases();
          lastLeaseRecovery = Date.now();
        }
        const request = await requests.claim(workerId);
        if (!request) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        await service.process(request);
      } catch (error) {
        logger.error({ error }, 'customer data deletion worker iteration failed');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  } finally {
    await service.close();
  }
}
