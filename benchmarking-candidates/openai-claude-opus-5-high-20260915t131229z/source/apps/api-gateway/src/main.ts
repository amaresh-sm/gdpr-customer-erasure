import Fastify from 'fastify';
import { config } from '../../../packages/config/src/index.js';
import { readiness } from './readiness.js';
import { registerUpstreamRoutes } from './routes.js';

process.env.SERVICE_NAME = 'api-gateway';
const settings = config();
const app = Fastify({
  logger: {
    level: settings.LOG_LEVEL,
    base: { service: 'api-gateway' },
    redact: ['req.headers.authorization', '*.apiKey', '*.providerToken'],
  },
  requestIdHeader: 'x-correlation-id',
});
app.get('/health', async () => ({ status: 'ok', service: 'api-gateway' }));
app.get('/ready', async (_request, reply) => {
  const status = await readiness(settings);
  return reply.code(status.ready ? 200 : 503).send(status);
});
app.addHook('onRequest', async (request, reply) => {
  request.headers['x-correlation-id'] = request.id;
  void reply.header('x-correlation-id', request.id);
});
await registerUpstreamRoutes(app, settings);
await app.listen({ host: '0.0.0.0', port: 3000 });
