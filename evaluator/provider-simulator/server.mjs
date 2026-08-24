import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3002);
const webhookSecret = process.env.PROCESSOR_WEBHOOK_SECRET ?? 'processor-webhook-secret';
const failedRefundAmount = Number(process.env.EVALUATOR_REFUND_FAILURE_AMOUNT ?? 2399);
const payments = new Map();
const refundAttempts = [];

function writeJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function dispatch(webhookUrl, type, data, eventId = `evt_${randomUUID()}`) {
  const payload = { id: eventId, type, createdAt: new Date().toISOString(), data };
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', webhookSecret).update(body).digest('hex');
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payflow-signature': signature },
      body,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // A candidate's webhook endpoint may be unavailable. The caller's workflow is scored separately.
  }
}

function schedulePaymentWebhook(providerPaymentId, input) {
  setTimeout(() => {
    const outcome = input.outcome === 'declined' ? 'failed' : 'succeeded';
    const eventType = `payment.${outcome}`;
    const data = {
      providerPaymentId,
      paymentId: input.paymentId,
      merchantId: input.merchantId,
      amount: input.amount,
      currency: input.currency,
      ...(outcome === 'failed' ? { failureCode: 'card_declined' } : {}),
    };
    void dispatch(input.webhookUrl, eventType, data, `evt_payment_${providerPaymentId}`);
    if (input.deliveryMode === 'duplicate') void dispatch(input.webhookUrl, eventType, data, `evt_payment_${providerPaymentId}`);
    if (input.deliveryMode === 'stale_processing') void dispatch(input.webhookUrl, 'payment.processing', data, `evt_processing_${providerPaymentId}`);
  }, 250);
}

function scheduleRefundWebhook(providerRefundId, providerPaymentId, input) {
  setTimeout(() => void dispatch(input.webhookUrl, 'refund.succeeded', {
    providerPaymentId,
    providerRefundId,
    refundId: input.refundId,
    paymentId: input.paymentId,
    merchantId: input.merchantId,
    amount: input.amount,
    currency: input.currency,
    reason: input.reason,
  }, `evt_refund_${providerRefundId}`), 250);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'provider-simulator'}`);
    if (request.method === 'GET' && url.pathname === '/health') return writeJson(response, 200, { ok: true });
    if (request.method === 'GET' && url.pathname === '/_evaluator/refund-attempts') return writeJson(response, 200, { attempts: refundAttempts });

    if (request.method === 'POST' && url.pathname === '/v1/payment-intents') {
      const input = await readJson(request);
      const providerPaymentId = `pi_${randomUUID()}`;
      payments.set(providerPaymentId, { ...input, status: 'succeeded' });
      schedulePaymentWebhook(providerPaymentId, input);
      if (input.outcome === 'timeout') return writeJson(response, 504, { error: 'provider_response_delayed' });
      return writeJson(response, 202, { id: providerPaymentId, status: 'processing' });
    }

    const refundMatch = /^\/v1\/payment-intents\/([^/]+)\/refunds$/.exec(url.pathname);
    if (request.method === 'POST' && refundMatch) {
      const input = await readJson(request);
      const providerPaymentId = decodeURIComponent(refundMatch[1]);
      refundAttempts.push({ providerPaymentId, body: input });
      if (!payments.has(providerPaymentId)) return writeJson(response, 409, { error: 'payment_not_refundable' });
      if (input.amount === failedRefundAmount) return writeJson(response, 504, { error: 'provider_temporarily_unavailable' });
      const providerRefundId = `re_${randomUUID()}`;
      scheduleRefundWebhook(providerRefundId, providerPaymentId, input);
      return writeJson(response, 202, { id: providerRefundId, status: 'pending' });
    }

    return writeJson(response, 404, { error: 'not_found' });
  } catch (error) {
    return writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid_request' });
  }
});

server.listen(port, '0.0.0.0');
