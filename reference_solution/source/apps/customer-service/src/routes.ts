import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../../packages/auth/src/api-key.js';
import { config } from '../../../packages/config/src/index.js';
import { createCustomerSchema } from '../../../packages/contracts/src/domain.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { CustomerRepository } from './repository.js';
import { CustomerService } from './service.js';

const updateSchema = z.object({ version: z.number().int().positive(), email: z.string().email().optional(),
  name: z.string().min(1).optional(), phone: z.string().nullable().optional() });
const addressSchema = z.object({ kind: z.enum(['billing','shipping','other']), line1: z.string().min(1),
  line2: z.string().optional(), city: z.string().min(1), region: z.string().optional(),
  postalCode: z.string().min(1), country: z.string().length(2) });
const contactSchema = z.object({ kind: z.enum(['email','phone','emergency']), value: z.string().min(3), isPrimary: z.boolean().default(false) });
const paymentMethodSchema = z.object({ providerToken: z.string().min(8), type: z.enum(['card','bank_account']),
  brand: z.string().optional(), last4: z.string().length(4).optional(), billingName: z.string().optional(),
  billingAddress: z.record(z.unknown()).optional() });
const supportSchema = z.object({ subject: z.string().min(3).max(200), body: z.string().min(1).max(10_000) });
const importSchema = z.object({ source: z.string().min(2), record: z.record(z.unknown()) });

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  const service = new CustomerService();
  const repository = new CustomerRepository();
  app.get('/health', async () => ({ status: 'ok', service: 'customer-service' }));
  app.post('/v1/customers', async (request, reply) => {
    const principal = await authenticate(request, 'customers:write');
    const customer = await service.create(principal.merchantId, createCustomerSchema.parse(request.body));
    return reply.code(201).send(customer);
  });
  app.get('/v1/customers', async (request) => {
    const principal = await authenticate(request, 'customers:read');
    const query = z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    return { data: await repository.list(principal.merchantId, query.cursor, query.limit) };
  });
  app.get('/v1/customers/:id', async (request, reply) => {
    const principal = await authenticate(request, 'customers:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const customer = await repository.find(principal.merchantId, id);
    return customer ? customer : reply.code(404).send({ error: 'customer_not_found' });
  });
  app.patch('/v1/customers/:id', async (request) => {
    const principal = await authenticate(request, 'customers:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { version, ...fields } = updateSchema.parse(request.body);
    return service.update(principal.merchantId, id, version, fields);
  });
  app.post('/v1/customers/:id/addresses', async (request, reply) => {
    const principal = await authenticate(request, 'customers:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = addressSchema.parse(request.body);
    const addressId = await transaction((client) => service.addAddress(client, principal.merchantId, id, input));
    return reply.code(201).send({ id: addressId });
  });
  app.post('/v1/customers/:id/contacts', async (request, reply) => {
    const principal = await authenticate(request, 'customers:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const contactId = await transaction((client) => service.addContact(client, principal.merchantId, id, contactSchema.parse(request.body)));
    return reply.code(201).send({ id: contactId });
  });
  app.post('/v1/customers/:id/payment-methods', async (request, reply) => {
    const principal = await authenticate(request, 'customers:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const paymentMethodId = await transaction((client) => service.attachPaymentMethod(client, principal.merchantId, id, paymentMethodSchema.parse(request.body)));
    return reply.code(201).send({ id: paymentMethodId });
  });
  app.get('/v1/customers/:id/payment-methods/:paymentMethodId', async (request, reply) => {
    const principal = await authenticate(request, 'customers:read');
    const { id, paymentMethodId } = z.object({ id: z.string().uuid(), paymentMethodId: z.string().uuid() }).parse(request.params);
    return await repository.findPaymentMethod(principal.merchantId, id, paymentMethodId) ??
      reply.code(404).send({ error: 'payment_method_not_found' });
  });
  app.get('/internal/customers/:id/payment-methods/:paymentMethodId', async (request, reply) => {
    if (request.headers['x-internal-service-token'] !== config().INTERNAL_SERVICE_TOKEN) {
      return reply.code(401).send({ error: 'internal_authentication_required' });
    }
    const { id, paymentMethodId } = z.object({ id: z.string().uuid(), paymentMethodId: z.string().uuid() }).parse(request.params);
    const merchantId = z.string().uuid().parse(request.headers['x-merchant-id']);
    return await repository.findPaymentMethodForProvider(merchantId, id, paymentMethodId) ??
      reply.code(404).send({ error: 'payment_method_not_found' });
  });
  app.post('/internal/customers/:id/provider-customers', async (request, reply) => {
    if (request.headers['x-internal-service-token'] !== config().INTERNAL_SERVICE_TOKEN) {
      return reply.code(401).send({ error: 'internal_authentication_required' });
    }
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const merchantId = z.string().uuid().parse(request.headers['x-merchant-id']);
    const { providerName } = z.object({ providerName: z.literal('payflow_sandbox').default('payflow_sandbox') }).parse(request.body);
    return { provider_customer_id: await service.ensureProviderCustomer(merchantId, id, providerName) };
  });
  app.post('/v1/customers/:id/support-tickets', async (request, reply) => {
    const principal = await authenticate(request, 'customers:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = supportSchema.parse(request.body);
    const ticketId = await transaction((client) => service.createSupportTicket(client, principal.merchantId, id, input.subject, input.body));
    return reply.code(201).send({ id: ticketId });
  });
  app.post('/v1/customer-imports', async (request, reply) => {
    const principal = await authenticate(request, 'customers:write');
    const input = importSchema.parse(request.body);
    const importId = await service.importCustomerArtifact(principal.merchantId, input.source, JSON.stringify(input.record));
    return reply.code(201).send({ id: importId });
  });
}
