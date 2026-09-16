import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../../packages/auth/src/api-key.js';
import { ErasureService } from './erasure-service.js';

const idempotencyKeySchema = z.string().min(8).max(200);

export async function erasureRoutes(app: FastifyInstance): Promise<void> {
  const service = new ErasureService();
  app.post('/v1/customers/:customerId/erasure-requests', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { customerId } = z.object({ customerId: z.string().uuid() }).parse(request.params);
    const idempotencyKey = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!idempotencyKey.success) return reply.code(400).send({ error: 'valid_idempotency_key_required' });
    const result = await service.request(principal.merchantId, customerId, idempotencyKey.data);
    return reply.code(result.status).send(result.body);
  });

  app.get('/v1/erasure-requests/:requestId', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
    const found = await service.find(principal.merchantId, requestId);
    return found ?? reply.code(404).send({ error: 'erasure_request_not_found' });
  });
}
