import { randomUUID } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { transaction } from '../../../packages/database/src/pool.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureStepError, executeErasure } from './executor.js';
import { ErasureWorkerRepository, type ErasureRequestRow } from './repository.js';

process.env.SERVICE_NAME = 'privacy-worker';
const repository = new ErasureWorkerRepository();
const workerId = `privacy-worker-${randomUUID()}`;
const controller = new AbortController();

async function finalize(request: ErasureRequestRow): Promise<void> {
  await transaction(async (client) => {
    await repository.complete(client, request.id);
    await client.query(
      `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
       VALUES($1,'system','erasure_request',$2,'customer.erasure.completed','{}',$3)`,
      [request.merchant_id, request.id, uuid()],
    );
  });
}

async function run(signal: AbortSignal): Promise<void> {
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
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
      await executeErasure(request);
      await finalize(request);
      logger.info({ requestId: request.id }, 'erasure request completed');
    } catch (error) {
      const code = error instanceof ErasureStepError ? error.code : 'database_cleanup_failed';
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
      logger.error({ error, requestId: request.id, code, cause }, 'erasure request attempt failed');
      await repository.fail(request, code);
    }
  }
}

void run(controller.signal);
logger.info({ workerId }, 'privacy worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => controller.abort());
