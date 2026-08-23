import Fastify from 'fastify';
import { registerErrorHandler } from '../../../packages/http/src/errors.js';
import { config } from '../../../packages/config/src/index.js';
import { startOutboxPublisher } from '../../../packages/messaging/src/publisher.js';
import { paymentRoutes } from './routes.js';
import { registerProviderSandboxRoutes } from './provider-sandbox-routes.js';
import { registerReconciliationRoutes } from './reconciliation-routes.js';

process.env.SERVICE_NAME = 'payment-service';
const app = Fastify({ logger: { level: config().LOG_LEVEL, base: { service: 'payment-service' },
  redact: ['req.headers.authorization', '*.apiKey', '*.providerToken'] } });
registerErrorHandler(app);
await app.register(paymentRoutes);
await registerProviderSandboxRoutes(app);
await registerReconciliationRoutes(app);
const controller = new AbortController();
void startOutboxPublisher(controller.signal);
await app.listen({ host: '0.0.0.0', port: 3002 });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { controller.abort(); void app.close(); });
