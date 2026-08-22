import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../../packages/auth/src/api-key.js';
import { createPaymentSchema, createRefundSchema } from '../../../packages/contracts/src/domain.js';
import { PaymentRepository } from './repository.js';
import { PaymentService } from './service.js';
import { InvoiceService } from './invoices.js';

const invoiceSchema = z.object({ customerId: z.string().uuid(), currency: z.string().length(3).transform((v) => v.toUpperCase()),
  tax: z.number().int().nonnegative().default(0), lines: z.array(z.object({ description: z.string().min(1).max(500),
    quantity: z.number().int().positive(), unitAmount: z.number().int().positive() })).min(1).max(100) });

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  const service = new PaymentService();
  const repository = new PaymentRepository();
  const invoices = new InvoiceService();
  app.get('/health', async () => ({ status: 'ok', service: 'payment-service' }));
  app.post('/v1/payments', async (request, reply) => {
    const principal = await authenticate(request, 'payments:write');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) return reply.code(400).send({ error: 'valid_idempotency_key_required' });
    const result = await service.create(principal.merchantId, request.headers.authorization!, key, createPaymentSchema.parse(request.body));
    return reply.code(result.status).send(result.body);
  });
  app.get('/v1/payments', async (request) => {
    const principal = await authenticate(request, 'payments:read');
    const query = z.object({ customerId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    return { data: await repository.list(principal.merchantId, query.customerId, query.limit) };
  });
  app.get('/v1/payments/:id', async (request, reply) => {
    const principal = await authenticate(request, 'payments:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return await repository.find(principal.merchantId, id) ?? reply.code(404).send({ error: 'payment_not_found' });
  });
  app.post('/v1/payments/:id/refunds', async (request, reply) => {
    const principal = await authenticate(request, 'payments:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reply.code(202).send(await service.refund(principal.merchantId, id, createRefundSchema.parse(request.body)));
  });
  app.post('/v1/invoices', async (request, reply) => {
    const principal = await authenticate(request, 'payments:write');
    return reply.code(201).send(await invoices.create(principal.merchantId, request.headers.authorization!, invoiceSchema.parse(request.body)));
  });
}
