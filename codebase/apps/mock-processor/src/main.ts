import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from '../../../packages/config/src/index.js';

process.env.SERVICE_NAME = 'mock-processor';
const app = Fastify({ logger: true });
const payments = new Map<string, { paymentId: string; merchantId: string; amount: number; currency: string; status: string }>();

const paymentSchema = z.object({
  merchantId: z.string().uuid(), paymentId: z.string().uuid(), amount: z.number().int().positive(),
  currency: z.string().length(3), paymentMethodId: z.string().uuid(), webhookUrl: z.string().url()
});
const refundSchema = z.object({
  refundId: z.string().uuid(), paymentId: z.string().uuid(), merchantId: z.string().uuid(),
  amount: z.number().int().positive(), currency: z.string().length(3), reason: z.string(), webhookUrl: z.string().url()
});

async function dispatch(webhookUrl: string, eventType: string, data: Record<string, unknown>, duplicate = false): Promise<void> {
  const payload = { id: `evt_${randomUUID()}`, type: eventType, createdAt: new Date().toISOString(), data };
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', config().PROCESSOR_WEBHOOK_SECRET).update(body).digest('hex');
  const deliver = async () => {
    try { await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payflow-signature': signature }, body }); }
    catch (error) { app.log.error({ error, webhookUrl }, 'webhook delivery failed'); }
  };
  await deliver();
  if (duplicate) await deliver();
}

app.get('/health', async () => ({ status: 'ok', service: 'mock-processor' }));
app.post('/v1/payment-intents', async (request, reply) => {
  const input = paymentSchema.parse(request.body);
  const id = `pi_${randomUUID()}`;
  const outcome = request.headers['x-test-outcome'] === 'failed' ? 'failed' : 'succeeded';
  payments.set(id, { paymentId: input.paymentId, merchantId: input.merchantId, amount: input.amount, currency: input.currency, status: 'processing' });
  setTimeout(() => {
    const stored = payments.get(id);
    if (stored) stored.status = outcome;
    void dispatch(input.webhookUrl, `payment.${outcome}`, {
      providerPaymentId: id, ...stored,
      failureCode: outcome === 'failed' ? 'card_declined' : undefined
    }, request.headers['x-test-duplicate'] === 'true');
  }, Number(request.headers['x-test-delay-ms'] ?? 250));
  return reply.code(202).send({ id, status: 'processing' });
});
app.post('/v1/payment-intents/:id/refunds', async (request, reply) => {
  const { id } = z.object({ id: z.string().min(4) }).parse(request.params);
  const input = refundSchema.parse(request.body);
  const payment = payments.get(id);
  if (!payment || payment.status !== 'succeeded') return reply.code(409).send({ error: 'payment_not_refundable' });
  const providerRefundId = `re_${randomUUID()}`;
  setTimeout(() => void dispatch(input.webhookUrl, 'refund.succeeded', { providerPaymentId: id, providerRefundId, ...input }), 250);
  return reply.code(202).send({ id: providerRefundId, status: 'pending' });
});
app.get('/v1/settlements', async () => ({
  generatedAt: new Date().toISOString(),
  transactions: [...payments.entries()].filter(([, value]) => value.status === 'succeeded').map(([providerPaymentId, value]) => ({ providerPaymentId, ...value })),
}));
await app.listen({ host: '0.0.0.0', port: 4000 });
