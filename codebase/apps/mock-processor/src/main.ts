import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from '../../../packages/config/src/index.js';
import { pool } from '../../../packages/database/src/pool.js';
import { ProviderSandboxRepository } from './repository.js';

process.env.SERVICE_NAME = 'mock-processor';
const app = Fastify({ logger: true });
const repository = new ProviderSandboxRepository();
const processingDelayMs = 250;
const controller = new AbortController();

const paymentSchema = z.object({
  merchantId: z.string().uuid(), paymentId: z.string().uuid(), amount: z.number().int().positive(),
  currency: z.string().length(3), paymentMethodId: z.string().uuid(), webhookUrl: z.string().url(),
});
const refundSchema = z.object({
  refundId: z.string().uuid(), paymentId: z.string().uuid(), merchantId: z.string().uuid(),
  amount: z.number().int().positive(), currency: z.string().length(3), reason: z.string(), webhookUrl: z.string().url(),
});

async function dispatch(
  webhookUrl: string,
  eventId: string,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  const payload = { id: eventId, type: eventType, createdAt: new Date().toISOString(), data };
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', config().PROCESSOR_WEBHOOK_SECRET).update(body).digest('hex');
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payflow-signature': signature },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`webhook endpoint returned ${response.status}`);
}

async function deliverAvailable(): Promise<boolean> {
  const payment = await repository.claimPaymentCallback();
  if (payment) {
    try {
      await dispatch(payment.webhook_url, `evt_payment_${payment.id}`, 'payment.succeeded', {
        providerPaymentId: payment.id,
        paymentId: payment.payment_id,
        merchantId: payment.merchant_id,
        amount: Number(payment.amount),
        currency: payment.currency,
      });
      await repository.markPaymentCallbackDelivered(payment.id);
    } catch (error) {
      app.log.warn({ error, providerPaymentId: payment.id }, 'payment webhook delivery deferred');
      await repository.deferPaymentCallback(payment.id, payment.webhook_attempts, error);
    }
    return true;
  }

  const refund = await repository.claimRefundCallback();
  if (!refund) return false;
  try {
    await dispatch(refund.webhook_url, `evt_refund_${refund.id}`, 'refund.succeeded', {
      providerPaymentId: refund.provider_payment_id,
      providerRefundId: refund.id,
      refundId: refund.refund_id,
      paymentId: refund.payment_id,
      merchantId: refund.merchant_id,
      amount: Number(refund.amount),
      currency: refund.currency,
      reason: refund.reason,
    });
    await repository.markRefundCallbackDelivered(refund.id);
  } catch (error) {
    app.log.warn({ error, providerRefundId: refund.id }, 'refund webhook delivery deferred');
    await repository.deferRefundCallback(refund.id, refund.webhook_attempts, error);
  }
  return true;
}

async function runDispatcher(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const delivered = await deliverAvailable();
      if (!delivered) await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      app.log.warn({ error }, 'provider dispatcher dependency unavailable');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

app.get('/health', async () => ({ status: 'ok', service: 'mock-processor' }));
app.post('/v1/payment-intents', async (request, reply) => {
  const input = paymentSchema.parse(request.body);
  const id = `pi_${randomUUID()}`;
  await repository.createPayment(id, input, processingDelayMs);
  return reply.code(202).send({ id, status: 'processing' });
});
app.post('/v1/payment-intents/:id/refunds', async (request, reply) => {
  const { id } = z.object({ id: z.string().min(4) }).parse(request.params);
  const input = refundSchema.parse(request.body);
  if (!await repository.paymentIsRefundable(id)) return reply.code(409).send({ error: 'payment_not_refundable' });
  const providerRefundId = `re_${randomUUID()}`;
  await repository.createRefund(providerRefundId, id, input, processingDelayMs);
  return reply.code(202).send({ id: providerRefundId, status: 'pending' });
});
app.get('/v1/settlements', async () => ({
  generatedAt: new Date().toISOString(),
  transactions: (await repository.settlements()).map((payment) => ({
    providerPaymentId: payment.provider_payment_id,
    paymentId: payment.payment_id,
    merchantId: payment.merchant_id,
    amount: Number(payment.amount),
    currency: payment.currency,
  })),
}));

void runDispatcher(controller.signal);
await app.listen({ host: '0.0.0.0', port: 4000 });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { controller.abort(); void app.close(); void pool.end(); });
}
