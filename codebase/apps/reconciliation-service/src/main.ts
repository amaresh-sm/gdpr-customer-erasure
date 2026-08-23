import Fastify from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../../packages/auth/src/api-key.js';
import { registerErrorHandler } from '../../../packages/http/src/errors.js';
import { config } from '../../../packages/config/src/index.js';
import { startOutboxPublisher } from '../../../packages/messaging/src/publisher.js';
import { ReconciliationService } from './service.js';

process.env.SERVICE_NAME = 'reconciliation-service';
const app = Fastify({
  logger: {
    level: config().LOG_LEVEL, base: { service: 'reconciliation-service' },
    redact: ['req.headers.authorization', '*.apiKey', '*.providerToken']
  }
});
registerErrorHandler(app);
const service = new ReconciliationService();
app.get('/health', async () => ({ status: 'ok', service: 'reconciliation-service' }));
app.post('/v1/reconciliation/imports', async (request, reply) => {
  const principal = await authenticate(request, 'reconciliation:write');
  return reply.code(201).send(await service.importSettlement(principal.merchantId));
});
app.post('/v1/reconciliation/runs', async (request, reply) => {
  const principal = await authenticate(request, 'reconciliation:write');
  return reply.code(201).send(await service.reconcile(principal.merchantId));
});
app.get('/v1/reconciliation/runs/:id', async (request, reply) => {
  const principal = await authenticate(request, 'reconciliation:read');
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  return await service.getRun(principal.merchantId, id) ?? reply.code(404).send({ error: 'run_not_found' });
});
const controller = new AbortController();
void startOutboxPublisher(controller.signal);
await app.listen({ host: '0.0.0.0', port: 3004 });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { controller.abort(); void app.close(); });
