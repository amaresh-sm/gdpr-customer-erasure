import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../../packages/auth/src/api-key.js';
import { ErasureRequestRepository } from './erasure-request-repository.js';
import { ErasureService } from './erasure-service.js';
import { CustomerRepository } from './repository.js';

const requestParams = z.object({ customerId: z.string().uuid() });
const statusParams = z.object({ requestId: z.string().uuid() });
const idempotencyKeySchema = z.string().min(8).max(200);

export async function erasureRoutes(app: FastifyInstance): Promise<void> {
  const requests = new ErasureRequestRepository();
  const service = new ErasureService(requests);
  const customers = new CustomerRepository();

  app.post('/v1/customers/:customerId/erasure-requests', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { customerId } = requestParams.parse(request.params);
    const key = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!key.success) return reply.code(400).send({ error: 'valid_idempotency_key_required' });

    /*
     * A completed request has already deleted the profile, so absence alone cannot mean "unknown
     * customer" — that would make a successful deletion look like a bad request on the next poll.
     * An existing request for this merchant is therefore authority enough to resume.
     */
    const existing = await requests.findByCustomer(principal.merchantId, customerId);
    if (!existing && !await customers.find(principal.merchantId, customerId)) {
      return reply.code(404).send({ error: 'customer_not_found' });
    }

    const result = await service.request(principal.merchantId, customerId, key.data);
    return reply.code(result.status).send(result.body);
  });

  app.get('/v1/erasure-requests/:requestId', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { requestId } = statusParams.parse(request.params);
    const view = await service.get(principal.merchantId, requestId);
    return view ?? reply.code(404).send({ error: 'erasure_request_not_found' });
  });
}
