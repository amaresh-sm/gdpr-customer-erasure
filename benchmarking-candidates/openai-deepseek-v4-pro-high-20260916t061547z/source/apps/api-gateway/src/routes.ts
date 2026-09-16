import proxy from '@fastify/http-proxy';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../../packages/config/src/index.js';

interface RouteTarget {
  prefix: string;
  upstream: string;
}

/** Registers the stable public prefixes owned by each internal HTTP service. */
export async function registerUpstreamRoutes(app: FastifyInstance, settings: Config): Promise<void> {
  const routes: RouteTarget[] = [
    { upstream: settings.CUSTOMER_SERVICE_URL, prefix: '/v1/customers' },
    { upstream: settings.CUSTOMER_SERVICE_URL, prefix: '/v1/customer-imports' },
    { upstream: settings.PAYMENT_SERVICE_URL, prefix: '/v1/payments' },
    { upstream: settings.PAYMENT_SERVICE_URL, prefix: '/v1/refunds' },
    { upstream: settings.PAYMENT_SERVICE_URL, prefix: '/v1/invoices' },
    { upstream: settings.RECONCILIATION_SERVICE_URL, prefix: '/v1/reconciliation' },
  ];
  for (const route of routes) {
    await app.register(proxy, {
      upstream: route.upstream,
      prefix: route.prefix,
      rewritePrefix: route.prefix,
    });
  }
}
