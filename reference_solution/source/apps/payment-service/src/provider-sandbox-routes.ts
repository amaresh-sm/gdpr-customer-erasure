import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../../packages/config/src/index.js';
import { pool } from '../../../packages/database/src/pool.js';

const payments = new Map<string, {
  paymentId: string; merchantId: string; amount: number; currency: string; status: string;
  providerCustomerId: string;
  outcome: 'succeeded' | 'declined' | 'timeout'; deliveryMode: 'standard' | 'duplicate' | 'stale_processing';
}>();

const paymentSchema = z.object({ merchantId: z.string().uuid(), paymentId: z.string().uuid(), amount: z.number().int().positive(),
  currency: z.string().length(3), paymentMethodId: z.string().uuid(), providerCustomerId: z.string().min(8),
  customer: z.object({ id: z.string().uuid(), email: z.string().email(), name: z.string().min(1), externalReference: z.string().min(1) }),
  outcome: z.enum(['succeeded','declined','timeout']),
  deliveryMode: z.enum(['standard','duplicate','stale_processing']), webhookUrl: z.string().url() });
const refundSchema = z.object({ refundId: z.string().uuid(), paymentId: z.string().uuid(), merchantId: z.string().uuid(),
  amount: z.number().int().positive(), currency: z.string().length(3), reason: z.string(), webhookUrl: z.string().url() });

async function dispatch(app: FastifyInstance, webhookUrl: string, eventType: string, data: Record<string, unknown>, duplicate = false): Promise<void> {
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

/** Registers the local provider sandbox within the payment deployable. */
export async function registerProviderSandboxRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/payment-intents', async (request, reply) => {
    const input = paymentSchema.parse(request.body);
    const id = `pi_${randomUUID()}`;
    const terminalStatus = input.outcome === 'declined' ? 'failed' : 'succeeded';
    await pool.query(
      `INSERT INTO provider_sandbox.customers(id,merchant_id,payflow_customer_id,email,name,external_reference)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(id) DO UPDATE SET merchant_id=EXCLUDED.merchant_id,payflow_customer_id=EXCLUDED.payflow_customer_id,
         email=EXCLUDED.email,name=EXCLUDED.name,external_reference=EXCLUDED.external_reference,updated_at=now()`,
      [input.providerCustomerId, input.merchantId, input.customer.id, input.customer.email, input.customer.name, input.customer.externalReference],
    );
    payments.set(id, { paymentId: input.paymentId, merchantId: input.merchantId, amount: input.amount, currency: input.currency,
      providerCustomerId: input.providerCustomerId, status: 'processing', outcome: input.outcome, deliveryMode: input.deliveryMode });
  setTimeout(() => {
    const stored = payments.get(id);
    if (!stored) return;
    stored.status = terminalStatus;
    const eventType = `payment.${terminalStatus}`;
    const data = { providerPaymentId: id, ...stored, failureCode: terminalStatus === 'failed' ? 'card_declined' : undefined };
    void (async () => {
      await dispatch(app, input.webhookUrl, eventType, data, stored.deliveryMode === 'duplicate');
      if (stored.deliveryMode === 'stale_processing') await dispatch(app, input.webhookUrl, 'payment.processing', data);
    })();
  }, 250);
    if (input.outcome === 'timeout') return reply.code(504).send({ error: 'provider_response_delayed' });
    return reply.code(202).send({ id, status: 'processing' });
  });
  app.post('/v1/payment-intents/:id/refunds', async (request, reply) => {
  const { id } = z.object({ id: z.string().min(4) }).parse(request.params);
  const input = refundSchema.parse(request.body);
  const payment = payments.get(id);
  if (!payment || payment.status !== 'succeeded') return reply.code(409).send({ error: 'payment_not_refundable' });
  const providerRefundId = `re_${randomUUID()}`;
  setTimeout(() => void dispatch(app, input.webhookUrl, 'refund.succeeded', { providerPaymentId: id, providerRefundId, ...input }), 250);
  return reply.code(202).send({ id: providerRefundId, status: 'pending' });
  });
  app.get('/v1/settlements', async () => ({
  generatedAt: new Date().toISOString(),
  transactions: [...payments.entries()].filter(([, value]) => value.status === 'succeeded').map(([providerPaymentId, value]) => ({ providerPaymentId, ...value })),
  }));
}
