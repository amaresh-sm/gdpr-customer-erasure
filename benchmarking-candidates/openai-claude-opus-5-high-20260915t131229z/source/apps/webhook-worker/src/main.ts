import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from '../../../packages/config/src/index.js';
import { registerErrorHandler } from '../../../packages/http/src/errors.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { processProviderEvent } from './processor.js';
import { WebhookRepository } from './repository.js';

process.env.SERVICE_NAME = 'webhook-worker';
const eventSchema = z.object({ id: z.string().min(5), type: z.string().min(3), createdAt: z.string().datetime(), data: z.record(z.unknown()) });
const repository = new WebhookRepository();
const app = Fastify({
  logger: {
    level: config().LOG_LEVEL, base: { service: 'webhook-worker' },
    redact: ['req.headers.authorization', '*.apiKey', '*.providerToken']
  }
});
registerErrorHandler(app);
app.get('/health', async () => ({ status: 'ok', service: 'webhook-worker' }));
app.post('/provider/webhooks', async (request, reply) => {
  const event = eventSchema.parse(request.body);
  const supplied = String(request.headers['x-payflow-signature'] ?? '');
  const expected = createHmac('sha256', config().PROCESSOR_WEBHOOK_SECRET).update(JSON.stringify(event)).digest('hex');
  const valid = supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return reply.code(401).send({ error: 'invalid_signature' });
  await repository.accept(event.id, event.type, supplied, event);
  return reply.code(202).send({ accepted: true });
});

const controller = new AbortController();
const workerId = `webhook-worker-${randomUUID()}`;

async function run(signal: AbortSignal): Promise<void> {
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastLeaseRecovery > 30_000) {
      await repository.recoverExpiredLeases();
      lastLeaseRecovery = Date.now();
    }
    const row = await repository.claim(workerId);
    if (!row) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try { await processProviderEvent(row.id, eventSchema.parse(row.payload)); }
    catch (error) {
      logger.error({ error, webhookId: row.id }, 'provider webhook processing failed');
      await repository.fail(row, error);
    }
  }
}
void run(controller.signal);
await app.listen({ host: '0.0.0.0', port: 3010 });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { controller.abort(); void app.close(); });
