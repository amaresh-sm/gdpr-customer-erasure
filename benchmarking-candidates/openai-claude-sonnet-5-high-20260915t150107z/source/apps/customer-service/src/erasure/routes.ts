import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../../../packages/auth/src/api-key.js';
import { ErasureService } from './service.js';

const idempotencyKeySchema = z.string().min(8).max(200);
const paramsSchema = z.object({ customerId: z.string().uuid() });
const requestIdSchema = z.object({ requestId: z.string().uuid() });

/** Registers the merchant-facing customer data deletion API. */
export async function erasureRoutes(app: FastifyInstance): Promise<void> {
  const service = new ErasureService();

  app.post('/v1/customers/:customerId/erasure-requests', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { customerId } = paramsSchema.parse(request.params);
    const key = request.headers['idempotency-key'];
    const parsedKey = idempotencyKeySchema.safeParse(key);
    if (!parsedKey.success) return reply.code(400).send({ error: 'valid_idempotency_key_required' });
    const result = await service.createOrResume(principal.merchantId, customerId, parsedKey.data);
    return reply.code(result.status).send(result.body);
  });

  app.get('/v1/erasure-requests/:requestId', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { requestId } = requestIdSchema.parse(request.params);
    const found = await service.find(principal.merchantId, requestId);
    return found ?? reply.code(404).send({ error: 'erasure_request_not_found' });
  });
}
