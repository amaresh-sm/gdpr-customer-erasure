import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../../packages/auth/src/api-key.js';
import { ErasureService } from './erasure-service.js';

const idempotencyKeySchema = z.string().min(8).max(200);

/** Registers the customer data deletion API owned by the customers bounded context. */
export async function registerErasureRoutes(app: FastifyInstance): Promise<void> {
  const service = new ErasureService();
  app.post('/v1/customers/:customerId/erasure-requests', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { customerId } = z.object({ customerId: z.string().uuid() }).parse(request.params);
    const key = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!key.success) return reply.code(400).send({ error: 'valid_idempotency_key_required' });
    const result = await service.request(principal.merchantId, customerId, key.data);
    return reply.code(result.status).send(result.body);
  });
  app.get('/v1/erasure-requests/:requestId', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
    return await service.get(principal.merchantId, requestId)
      ?? reply.code(404).send({ error: 'erasure_request_not_found' });
  });
}
