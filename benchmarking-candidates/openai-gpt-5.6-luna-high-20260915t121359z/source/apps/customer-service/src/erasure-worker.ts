import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureRepository } from './erasure-repository.js';
import { ErasureService, newErasureWorkerId } from './erasure-service.js';

export async function startErasureWorker(signal: AbortSignal): Promise<() => Promise<void>> {
  const repository = new ErasureRepository();
  const service = new ErasureService();
  const workerId = newErasureWorkerId();
  let lastLeaseRecovery = 0;

  void (async () => {
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
          await service.run(request, workerId);
        } catch (error) {
          logger.error({ error, requestId: request.id }, 'customer erasure failed');
        }
      } catch (error) {
        logger.error({ error }, 'customer erasure worker loop failed');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  })();

  return async () => await service.close();
}
