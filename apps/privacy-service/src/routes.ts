import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../../packages/auth/src/api-key.js';
import { PrivacyRepository } from './repository.js';

const idempotencyKeySchema = z.string().min(8).max(200);

export async function privacyRoutes(app: FastifyInstance): Promise<void> {
  const repository = new PrivacyRepository();
  app.get('/health', async () => ({ status: 'ok', service: 'privacy-service' }));

  app.post('/v1/customers/:customerId/erasure-requests', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { customerId } = z.object({ customerId: z.string().uuid() }).parse(request.params);
    const idempotencyKey = idempotencyKeySchema.parse(request.headers['idempotency-key']);
    const erasure = await repository.createOrGet(principal.merchantId, customerId, idempotencyKey);
    return reply.code(202).send(repository.toPublic(erasure));
  });

  app.get('/v1/erasure-requests/:requestId', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
    const erasure = await repository.find(principal.merchantId, requestId);
    return erasure ? repository.toPublic(erasure) : reply.code(404).send({ error: 'erasure_request_not_found' });
  });
}
