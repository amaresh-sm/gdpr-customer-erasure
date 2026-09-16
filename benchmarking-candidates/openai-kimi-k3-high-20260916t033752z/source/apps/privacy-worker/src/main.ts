import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../../../packages/config/src/index.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureStepError, ErasureWorkflow } from './erase.js';
import { ErasureWorkerRepository } from './repository.js';

process.env.SERVICE_NAME = 'privacy-worker';
const redis = new Redis(config().REDIS_URL);
const repository = new ErasureWorkerRepository();
const workflow = new ErasureWorkflow(repository, redis);
const workerId = `privacy-worker-${randomUUID()}`;
const controller = new AbortController();

async function run(signal: AbortSignal): Promise<void> {
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
        await workflow.run(request, workerId);
        logger.info({ requestId: request.id }, 'erasure request completed');
      } catch (error) {
        const code = error instanceof ErasureStepError ? error.code : 'erasure_step_failed';
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
        logger.error({ error, cause, requestId: request.id }, 'erasure request attempt failed');
        try {
          await repository.fail(request, workerId, code);
        } catch (failError) {
          logger.error({ error: failError, requestId: request.id }, 'erasure request failure update failed');
        }
      }
    } catch (error) {
      logger.error({ error }, 'privacy worker dependency unavailable');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

void run(controller.signal);
logger.info({ workerId }, 'privacy worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { controller.abort(); void redis.quit(); });
}
