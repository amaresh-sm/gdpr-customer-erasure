import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureService } from './erasure-service.js';

const service = new ErasureService();
let running = false;

export async function processAvailableErasures(limit = 10): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let count = 0; count < limit; count += 1) {
      if (!await service.processOne()) return;
    }
  } catch (error) {
    logger.error({ error }, 'erasure worker iteration failed');
  } finally {
    running = false;
  }
}

export function startErasureWorker(signal: AbortSignal): void {
  const timer = setInterval(() => {
    void processAvailableErasures().catch((error) => logger.error({ error }, 'erasure worker failed'));
  }, 250);
  signal.addEventListener('abort', () => clearInterval(timer));
  void processAvailableErasures();
}
