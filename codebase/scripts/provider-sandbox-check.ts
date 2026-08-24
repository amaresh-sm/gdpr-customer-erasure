import { randomUUID } from 'node:crypto';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const apiKey = process.env.PAYFLOW_API_KEY ?? 'pf_local_dev_northstar_4ad1539de977';

type Payment = { id: string; status: string; version?: number };

async function api<T>(path: string, method = 'GET', body?: unknown, expected = 200, headers: Record<string, string> = {}): Promise<T> {
  const request: RequestInit = {
    method,
    headers: { authorization: `Bearer ${apiKey}`, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  };
  if (body !== undefined) request.body = JSON.stringify(body);
  const response = await fetch(`${gateway}${path}`, {
    ...request,
  });
  const payload = await response.json() as T;
  if (response.status !== expected) throw new Error(`${method} ${path}: expected ${expected}, received ${response.status}`);
  return payload;
}

async function waitForPayment(paymentId: string, status: string): Promise<Payment> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const payment = await api<Payment>(`/v1/payments/${paymentId}`);
    if (payment.status === status) return payment;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`payment ${paymentId} did not reach ${status}`);
}

const suffix = randomUUID();
const customer = await api<{ id: string }>('/v1/customers', 'POST', {
  externalReference: `provider-check-${suffix}`, email: `provider-check-${suffix}@example.test`,
  name: 'Provider scenario check', metadata: { source: 'provider-sandbox-check' },
}, 201);

async function attach(token: string): Promise<string> {
  const method = await api<{ id: string }>(`/v1/customers/${customer.id}/payment-methods`, 'POST', {
    providerToken: token, type: 'card', brand: 'visa', last4: '4242', billingName: 'Provider scenario check',
  }, 201);
  return method.id;
}

async function createPayment(paymentMethodId: string, key: string, expected = 202): Promise<Payment> {
  return await api<Payment>('/v1/payments', 'POST', {
    customerId: customer.id, paymentMethodId, amount: 1200, currency: 'USD', description: 'Provider sandbox scenario',
  }, expected, { 'idempotency-key': key });
}

const declined = await createPayment(await attach(`tok_sandbox_decline_duplicate_${suffix}`), `decline-${suffix}`);
await waitForPayment(declined.id, 'failed');

const timedOut = await createPayment(await attach(`tok_sandbox_timeout_${suffix}`), `timeout-${suffix}`, 502);
await waitForPayment(timedOut.id, 'succeeded');

const stale = await createPayment(await attach(`tok_sandbox_out_of_order_${suffix}`), `stale-${suffix}`);
const staleFinal = await waitForPayment(stale.id, 'succeeded');
if (staleFinal.version !== 2) throw new Error('stale processing webhook changed terminal payment version');

console.log(JSON.stringify({ declined: declined.id, timedOut: timedOut.id, stale: stale.id }, null, 2));
