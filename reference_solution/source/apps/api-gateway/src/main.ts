import Fastify from 'fastify';
import proxy from '@fastify/http-proxy';
import { config } from '../../../packages/config/src/index.js';
import { logger } from '../../../packages/observability/src/logger.js';

process.env.SERVICE_NAME = 'api-gateway';
const settings = config();
const app = Fastify({ loggerInstance: logger, requestIdHeader: 'x-correlation-id' });
app.get('/health', async () => ({ status: 'ok', service: 'api-gateway' }));
app.post('/v1/customers/:customerId/erasure-requests', async (request, reply) => {
  const customerId = (request.params as { customerId: string }).customerId;
  const response = await fetch(`${settings.PRIVACY_SERVICE_URL}/v1/customers/${customerId}/erasure-requests`, {
    method: 'POST',
    headers: {
      authorization: String(request.headers.authorization ?? ''),
      'idempotency-key': String(request.headers['idempotency-key'] ?? ''),
      'x-correlation-id': request.id,
    },
  });
  return reply.code(response.status).send(await response.json());
});
await app.register(proxy, { upstream: settings.PRIVACY_SERVICE_URL, prefix: '/v1/erasure-requests', rewritePrefix: '/v1/erasure-requests' });
await app.register(proxy, { upstream: settings.CUSTOMER_SERVICE_URL, prefix: '/v1/customers', rewritePrefix: '/v1/customers' });
await app.register(proxy, { upstream: settings.CUSTOMER_SERVICE_URL, prefix: '/v1/customer-imports', rewritePrefix: '/v1/customer-imports' });
await app.register(proxy, { upstream: settings.PAYMENT_SERVICE_URL, prefix: '/v1/payments', rewritePrefix: '/v1/payments' });
await app.register(proxy, { upstream: settings.PAYMENT_SERVICE_URL, prefix: '/v1/refunds', rewritePrefix: '/v1/refunds' });
await app.register(proxy, { upstream: settings.PAYMENT_SERVICE_URL, prefix: '/v1/invoices', rewritePrefix: '/v1/invoices' });
await app.register(proxy, { upstream: settings.RECONCILIATION_SERVICE_URL, prefix: '/v1/reconciliation', rewritePrefix: '/v1/reconciliation' });
await app.listen({ host: '0.0.0.0', port: 3000 });
