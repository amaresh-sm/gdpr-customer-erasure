import { randomUUID } from 'node:crypto';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const apiKey = process.env.PAYFLOW_API_KEY ?? 'pf_local_dev_northstar_4ad1539de977';

async function api<T>(path: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, ...extraHeaders };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const response = await fetch(`${gateway}${path}`, init);
  const result = await response.json() as T;
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(result)}`);
  return result;
}

const personas = [
  {
    externalReference: 'crm-ada-001', email: 'ada.lovelace@example.test', name: 'Ada Lovelace', phone: '+1-415-555-0101',
    city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US'
  },
  {
    externalReference: 'crm-grace-002', email: 'grace.hopper@example.test', name: 'Grace Hopper', phone: '+1-212-555-0112',
    city: 'New York', region: 'NY', postalCode: '10001', country: 'US'
  },
  {
    externalReference: 'crm-katherine-003', email: 'katherine.johnson@example.test', name: 'Katherine Johnson', phone: '+1-757-555-0123',
    city: 'Hampton', region: 'VA', postalCode: '23666', country: 'US'
  },
];

const created: Array<{ customerId: string; paymentMethodId: string; paymentId: string }> = [];
const runSuffix = process.env.SCENARIO_ID ?? Date.now().toString(36);
for (const [index, person] of personas.entries()) {
  const uniquePerson = {
    ...person, externalReference: `${person.externalReference}-${runSuffix}`,
    email: person.email.replace('@', `+${runSuffix}@`)
  };
  const customer = await api<{ id: string }>('/v1/customers', 'POST', { ...uniquePerson, metadata: { segment: index === 0 ? 'enterprise' : 'retail', source: 'scenario-generator' } });
  await api(`/v1/customers/${customer.id}/addresses`, 'POST', {
    kind: 'billing', line1: `${100 + index} Market Street`,
    city: person.city, region: person.region, postalCode: person.postalCode, country: person.country
  });
  await api(`/v1/customers/${customer.id}/contacts`, 'POST', { kind: 'email', value: uniquePerson.email, isPrimary: true });
  const method = await api<{ id: string }>(`/v1/customers/${customer.id}/payment-methods`, 'POST', {
    providerToken: `tok_scenario_${randomUUID()}`, type: 'card', brand: index === 1 ? 'mastercard' : 'visa',
    last4: String(4242 + index).slice(-4), billingName: person.name,
    billingAddress: { line1: `${100 + index} Market Street`, city: person.city, postalCode: person.postalCode, country: person.country },
  });
  await api(`/v1/customers/${customer.id}/support-tickets`, 'POST', {
    subject: 'Question about recent activity',
    body: `Please contact me at ${person.email} or ${person.phone} about my account.`
  });
  await api('/v1/customer-imports', 'POST', { source: 'legacy-crm', record: { customerId: customer.id, ...uniquePerson, notes: 'Migrated priority customer' } });
  await api('/v1/invoices', 'POST', {
    customerId: customer.id, currency: 'USD', tax: 175,
    lines: [{ description: 'PayFlow annual platform subscription', quantity: 1, unitAmount: 5000 + index * 1000 }]
  });
  const paymentInput = {
    customerId: customer.id, paymentMethodId: method.id, amount: 2500 + index * 750,
    currency: 'USD', description: `Order for ${person.name}`
  };
  const idempotencyKey = `scenario-payment-${index}-${randomUUID()}`;
  const payment = await api<{ id: string }>('/v1/payments', 'POST', paymentInput, { 'idempotency-key': idempotencyKey });
  const replay = await api<{ id: string }>('/v1/payments', 'POST', paymentInput, { 'idempotency-key': idempotencyKey });
  if (replay.id !== payment.id) throw new Error('payment idempotency replay created a different resource');
  created.push({ customerId: customer.id, paymentMethodId: method.id, paymentId: payment.id });
}

await new Promise((resolve) => setTimeout(resolve, 2_000));
await api(`/v1/payments/${created[0]!.paymentId}/refunds`, 'POST', { amount: 500, reason: 'customer requested partial refund' });
await new Promise((resolve) => setTimeout(resolve, 1_000));
const imported = await api<{ settlementId: string }>('/v1/reconciliation/imports', 'POST');
const reconciliation = await api('/v1/reconciliation/runs', 'POST');
console.log(JSON.stringify({ customers: created, settlement: imported, reconciliation }, null, 2));
