import { randomUUID } from 'node:crypto';
import { logger } from '../../../../packages/observability/src/logger.js';
import { ErasureRepository } from './repository.js';
import { ErasureService } from './service.js';

/** Runs the resumable customer erasure workflow until the given signal aborts. */
export async function runErasureWorker(signal: AbortSignal): Promise<void> {
  const repository = new ErasureRepository();
  const service = new ErasureService(repository);
  const workerId = `customer-erasure-${randomUUID()}`;
  let lastLeaseRecovery = 0;

  while (!signal.aborted) {
    if (Date.now() - lastLeaseRecovery > 30_000) {
      await repository.recoverExpiredLeases();
      lastLeaseRecovery = Date.now();
    }
    const claimed = await repository.claim(workerId);
    if (!claimed) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try {
      await service.processOne(claimed);
    } catch (error) {
      logger.error({ error, requestId: claimed.id }, 'unexpected error processing erasure request');
    }
  }
}
