import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../../packages/config/src/index.js';
import { ProviderSandboxRepository } from './provider-sandbox-repository.js';

const processingDelayMs = 250;

const paymentSchema = z.object({
  merchantId: z.string().uuid(), paymentId: z.string().uuid(), amount: z.number().int().positive(),
  currency: z.string().length(3), paymentMethodId: z.string().uuid(),
  outcome: z.enum(['succeeded','declined','timeout']),
  deliveryMode: z.enum(['standard','duplicate','stale_processing']),
  webhookUrl: z.string().url(),
});
const refundSchema = z.object({
  refundId: z.string().uuid(), paymentId: z.string().uuid(), merchantId: z.string().uuid(),
  amount: z.number().int().positive(), currency: z.string().length(3), reason: z.string(), webhookUrl: z.string().url(),
});

async function dispatch(
  app: FastifyInstance,
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

async function deliverAvailable(app: FastifyInstance, repository: ProviderSandboxRepository): Promise<boolean> {
  const payment = await repository.claimPaymentCallback();
  if (payment) {
    try {
      const eventId = `evt_payment_${payment.id}`;
      const data = {
        providerPaymentId: payment.id,
        paymentId: payment.payment_id,
        merchantId: payment.merchant_id,
        amount: Number(payment.amount),
        currency: payment.currency,
        ...(payment.failure_code ? { failureCode: payment.failure_code } : {}),
      };
      await dispatch(app, payment.webhook_url, eventId, payment.event_type, data);
      if (payment.delivery_mode === 'duplicate') await dispatch(app, payment.webhook_url, eventId, payment.event_type, data);
      if (payment.delivery_mode === 'stale_processing') {
        await dispatch(app, payment.webhook_url, `evt_processing_${payment.id}`, 'payment.processing', data);
      }
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
    await dispatch(app, refund.webhook_url, `evt_refund_${refund.id}`, 'refund.succeeded', {
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

async function runDispatcher(app: FastifyInstance, repository: ProviderSandboxRepository, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const delivered = await deliverAvailable(app, repository);
      if (!delivered) await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      app.log.warn({ error }, 'provider dispatcher dependency unavailable');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/** Registers the local provider sandbox within the payment deployable. */
export async function registerProviderSandboxRoutes(app: FastifyInstance, signal: AbortSignal): Promise<void> {
  const repository = new ProviderSandboxRepository();
  void runDispatcher(app, repository, signal);
  app.post('/v1/payment-intents', async (request, reply) => {
  const input = paymentSchema.parse(request.body);
  const id = `pi_${randomUUID()}`;
  await repository.createPayment(id, input, processingDelayMs);
  if (input.outcome === 'timeout') return reply.code(504).send({ error: 'provider_response_delayed' });
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
}
