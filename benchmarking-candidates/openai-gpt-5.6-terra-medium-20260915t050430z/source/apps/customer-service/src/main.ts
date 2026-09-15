import Fastify from 'fastify';
import { registerErrorHandler } from '../../../packages/http/src/errors.js';
import { config } from '../../../packages/config/src/index.js';
import { startOutboxPublisher } from '../../../packages/messaging/src/publisher.js';
import { customerRoutes } from './routes.js';
import { CustomerService } from './service.js';

process.env.SERVICE_NAME = 'customer-service';
const app = Fastify({ logger: { level: config().LOG_LEVEL, base: { service: 'customer-service' },
  redact: ['req.headers.authorization', '*.apiKey', '*.providerToken'] } });
registerErrorHandler(app);
await app.register(customerRoutes);
const controller = new AbortController();
const erasureService = new CustomerService();
async function processErasures(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      if (!await erasureService.processOneErasure()) await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (error) {
      app.log.error({ error }, 'customer erasure processor failed');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
void processErasures(controller.signal);
void startOutboxPublisher(controller.signal);
await app.listen({ host: '0.0.0.0', port: 3001 });
for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal, () => { controller.abort(); void app.close(); });
