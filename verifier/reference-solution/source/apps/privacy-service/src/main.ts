import Fastify from 'fastify';
import { config } from '../../../packages/config/src/index.js';
import { registerErrorHandler } from '../../../packages/http/src/errors.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { privacyRoutes } from './routes.js';
import { runErasureWorker } from './worker.js';

process.env.SERVICE_NAME = 'privacy-service';
const app = Fastify({ logger: { level: config().LOG_LEVEL, base: { service: 'privacy-service' },
  redact: ['req.headers.authorization', '*.apiKey', '*.providerToken', '*.subject_context'] } });
registerErrorHandler(app);
await app.register(privacyRoutes);
const controller = new AbortController();
void runErasureWorker(controller.signal).catch((error) => logger.error({ error }, 'erasure worker stopped'));
await app.listen({ host: '0.0.0.0', port: 3005 });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { controller.abort(); void app.close(); });
}
