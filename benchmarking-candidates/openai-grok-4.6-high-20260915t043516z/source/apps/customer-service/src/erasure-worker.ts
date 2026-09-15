import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureService } from './erasure-service.js';

export async function startErasureWorker(signal: AbortSignal): Promise<void> {
  const service = new ErasureService();
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() - lastLeaseRecovery > 30_000) {
        await service.recoverExpiredLeases();
        lastLeaseRecovery = Date.now();
      }
      const request = await service.claim();
      if (!request) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      try {
        await service.process(request.id, request.merchant_id, request.customer_id);
      } catch (error) {
        logger.error({ error, requestId: request.id }, 'erasure request failed');
        await service.fail(request.id, error);
      }
    } catch (error) {
      logger.error({ error }, 'erasure worker loop failed');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
