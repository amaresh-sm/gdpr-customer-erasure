import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../../packages/auth/src/api-key.js';
import { isValidIdempotencyKey } from '../../../packages/privacy/src/idempotency.js';
import { getErasureRequest, requestCustomerErasure } from '../../../packages/privacy/src/service.js';

const customerParams = z.object({ customerId: z.string().uuid() });
const requestParams = z.object({ requestId: z.string().uuid() });

/** Registers the merchant-facing customer data deletion endpoints. */
export async function privacyRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/customers/:customerId/erasure-requests', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const key = request.headers['idempotency-key'];
    if (!isValidIdempotencyKey(key)) return reply.code(400).send({ error: 'valid_idempotency_key_required' });
    const { customerId } = customerParams.parse(request.params);
    try {
      return reply.code(202).send(await requestCustomerErasure(principal.merchantId, customerId, key));
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) {
        return reply.code(404).send({ error: 'customer_not_found' });
      }
      throw error;
    }
  });

  app.get('/v1/erasure-requests/:requestId', async (request, reply) => {
    const principal = await authenticate(request, 'privacy:erase');
    const { requestId } = requestParams.parse(request.params);
    try {
      return await getErasureRequest(principal.merchantId, requestId);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) {
        return reply.code(404).send({ error: 'erasure_request_not_found' });
      }
      throw error;
    }
  });
}
