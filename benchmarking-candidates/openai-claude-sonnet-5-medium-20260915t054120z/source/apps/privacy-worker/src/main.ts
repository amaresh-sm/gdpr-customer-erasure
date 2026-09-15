import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { registerErrorHandler } from '../../../packages/http/src/errors.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { startOutboxPublisher } from '../../../packages/messaging/src/publisher.js';
import {
  claimErasureRequest,
  completeErasureRequest,
  failErasureRequest,
  recoverExpiredErasureLeases,
  type ClaimedErasureRequest,
} from '../../../packages/privacy/src/erasure-lifecycle.js';
import { eraseCustomerData } from '../../../packages/privacy/src/erasure-workflow.js';

process.env.SERVICE_NAME = 'privacy-worker';
const workerId = `privacy-worker-${randomUUID()}`;
const controller = new AbortController();

async function processErasure(request: ClaimedErasureRequest): Promise<void> {
  await eraseCustomerData(request.merchant_id, request.customer_id);
  await completeErasureRequest(request);
}

async function run(signal: AbortSignal): Promise<void> {
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastLeaseRecovery > 30_000) {
      await recoverExpiredErasureLeases();
      lastLeaseRecovery = Date.now();
    }
    const request = await claimErasureRequest(workerId);
    if (!request) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try { await processErasure(request); }
    catch (error) {
      logger.error({ error, erasureRequestId: request.id }, 'erasure request failed');
      await transaction((client) => failErasureRequest(client, request, error));
    }
  }
}

const app = Fastify({ logger: { level: config().LOG_LEVEL, base: { service: 'privacy-worker' },
  redact: ['req.headers.authorization', '*.apiKey', '*.providerToken'] } });
registerErrorHandler(app);
app.get('/health', async () => ({ status: 'ok', service: 'privacy-worker' }));

void startOutboxPublisher(controller.signal);
void run(controller.signal);
await app.listen({ host: '0.0.0.0', port: 3011 });
logger.info({ workerId }, 'privacy worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { controller.abort(); void app.close(); });
