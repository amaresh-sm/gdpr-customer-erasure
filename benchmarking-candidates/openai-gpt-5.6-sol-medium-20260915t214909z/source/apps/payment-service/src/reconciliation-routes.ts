import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../../packages/auth/src/api-key.js';
import { ReconciliationService } from './reconciliation-service.js';

/** Registers reconciliation routes owned by the payments bounded context. */
export async function registerReconciliationRoutes(app: FastifyInstance): Promise<void> {
  const service = new ReconciliationService();
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
}
