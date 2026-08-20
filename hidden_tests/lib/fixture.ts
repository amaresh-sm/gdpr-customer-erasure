import { createHash, randomUUID } from 'node:crypto';
import { api, poll } from './http.js';
import { fixtureUuid, pool } from './clients.js';

export interface SubjectFixture {
  customerId: string;
  paymentMethodId: string;
  paymentId: string;
  email: string;
  name: string;
  phone: string;
  externalReference: string;
  canary: string;
  ticketId: string;
  importId: string;
  invoiceId: string;
}

export interface BenchmarkFixture {
  slot: string;
  merchantId: string;
  merchantKey: string;
  otherMerchantId: string;
  otherMerchantKey: string;
  normal: SubjectFixture;
  delayed: SubjectFixture;
  survivor: { customerId: string; email: string; name: string; phone: string; externalReference: string };
  delayedWebhookId: string;
  delayedJobId: string;
  normalFinancial: { amount: string; currency: string; status: string; postings: string; signedBalance: string };
}

async function provisionMerchant(slot: string, suffix: string): Promise<{ id: string; key: string }> {
  const id = fixtureUuid(`${slot}:merchant:${suffix}`);
  const key = `pf_hidden_${suffix}_${createHash('sha256').update(slot).digest('hex').slice(0, 20)}`;
  await pool.query(`INSERT INTO platform.merchants(id,name,default_currency) VALUES($1,$2,'USD') ON CONFLICT(id) DO NOTHING`,
    [id, `Hidden ${suffix} ${slot}`]);
  await pool.query(
    `INSERT INTO platform.api_keys(merchant_id,key_hash,label,scopes)
     VALUES($1,$2,'hidden verifier',ARRAY['customers:read','customers:write','payments:read','payments:write','reconciliation:read','reconciliation:write','privacy:erase'])
     ON CONFLICT(key_hash) DO UPDATE SET scopes=EXCLUDED.scopes`,
    [id, createHash('sha256').update(key).digest('hex')],
  );
  for (const [code, name, type] of [['PROCESSOR_CLEARING', 'Processor clearing', 'asset'],
    ['MERCHANT_PAYABLE', 'Merchant payable', 'liability']] as const) {
    await pool.query(
      `INSERT INTO payments.ledger_accounts(merchant_id,code,name,account_type,currency)
       VALUES($1,$2,$3,$4,'USD') ON CONFLICT(merchant_id,code,currency) DO NOTHING`, [id, code, name, type],
    );
  }
  return { id, key };
}

async function createSubject(apiKey: string, slot: string, label: string): Promise<SubjectFixture> {
  const canary = `PII_${label.toUpperCase()}_${slot}`;
  const email = `${label}.${slot}@erasure.test`;
  const name = `${label} Subject ${slot}`;
  const phone = `+1555${createHash('sha256').update(`${slot}:${label}`).digest('hex').slice(0, 7)}`;
  const externalReference = `crm-${label}-${slot}`;
  const customer = await api<{ id: string }>(apiKey, '/v1/customers', { method: 'POST', expected: 201,
    body: { externalReference, email, name, phone, metadata: { privateNote: canary, segment: 'benchmark' } } });
  await api(apiKey, `/v1/customers/${customer.body.id}/addresses`, { method: 'POST', expected: 201,
    body: { kind: 'billing', line1: `${canary} Avenue`, city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' } });
  await api(apiKey, `/v1/customers/${customer.body.id}/contacts`, { method: 'POST', expected: 201,
    body: { kind: 'email', value: email, isPrimary: true } });
  const method = await api<{ id: string }>(apiKey, `/v1/customers/${customer.body.id}/payment-methods`, {
    method: 'POST', expected: 201, body: { providerToken: `tok_${label}_${slot}_reference`, type: 'card',
      brand: 'visa', last4: '4242', billingName: name,
      billingAddress: { line1: `${canary} Avenue`, city: 'Austin', postalCode: '78701', country: 'US' } },
  });
  const ticket = await api<{ id: string }>(apiKey, `/v1/customers/${customer.body.id}/support-tickets`, {
    method: 'POST', expected: 201, body: { subject: `${canary} account question`, body: `Contact ${email}; ${canary}` },
  });
  const imported = await api<{ id: string }>(apiKey, '/v1/customer-imports', { method: 'POST', expected: 201,
    body: { source: 'hidden-fixture', record: { customerId: customer.body.id, email, canary } } });
  const invoice = await api<{ id: string }>(apiKey, '/v1/invoices', { method: 'POST', expected: 201,
    body: { customerId: customer.body.id, currency: 'USD', tax: 125,
      lines: [{ description: `Service for ${name}`, quantity: 1, unitAmount: 5000 }] } });
  return { customerId: customer.body.id, paymentMethodId: method.body.id, paymentId: '', email, name, phone,
    externalReference, canary, ticketId: ticket.body.id, importId: imported.body.id, invoiceId: invoice.body.id };
}

export async function seedFixture(slot: string): Promise<BenchmarkFixture> {
  const merchant = await provisionMerchant(slot, 'primary');
  const other = await provisionMerchant(slot, 'other');
  const normal = await createSubject(merchant.key, slot, 'normal');
  const delayed = await createSubject(merchant.key, slot, 'delayed');
  const survivorData = { email: `survivor.${slot}@erasure.test`, name: `Survivor ${slot}`,
    phone: '+15550001111', externalReference: `crm-survivor-${slot}` };
  const survivor = await api<{ id: string }>(merchant.key, '/v1/customers', { method: 'POST', expected: 201,
    body: { ...survivorData, metadata: { role: 'shared-ticket-survivor' } } });
  await pool.query(`INSERT INTO customers.support_participants(ticket_id,customer_id) VALUES($1,$2)`,
    [normal.ticketId, survivor.body.id]);
  await pool.query(
    `INSERT INTO customers.support_messages(merchant_id,ticket_id,author_type,author_id,body)
     VALUES($1,$2,'customer',$3,$4)`, [merchant.id, normal.ticketId, survivor.body.id, `SURVIVOR_MESSAGE_${slot}`],
  );

  const payment = await api<{ id: string }>(merchant.key, '/v1/payments', { method: 'POST', expected: 202,
    headers: { 'idempotency-key': `normal-payment-${slot}` }, body: { customerId: normal.customerId,
      paymentMethodId: normal.paymentMethodId, amount: 7300, currency: 'USD', description: `Order for ${normal.name}` } });
  normal.paymentId = payment.body.id;
  await poll(async () => (await pool.query<{ status: string }>(
    `SELECT status FROM payments.payment_intents WHERE id=$1`, [normal.paymentId])).rows[0]?.status,
  (status) => status === 'succeeded', 'normal payment success');
  await poll(async () => Number((await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM operations.document_manifests WHERE metadata->>'paymentId'=$1`, [normal.paymentId])).rows[0]!.count),
  (count) => count === 1, 'normal receipt');

  const delayedPaymentId = fixtureUuid(`${slot}:delayed-payment`);
  const providerPaymentId = `pi_hidden_${createHash('sha256').update(slot).digest('hex').slice(0, 16)}`;
  await pool.query(
    `INSERT INTO payments.payment_intents
     (id,merchant_id,customer_id,payment_method_id,amount,currency,status,description,provider_payment_id,customer_snapshot)
     VALUES($1,$2,$3,$4,9100,'USD','processing',$5,$6,$7)`,
    [delayedPaymentId, merchant.id, delayed.customerId, delayed.paymentMethodId, `Order for ${delayed.name}`,
      providerPaymentId, { id: delayed.customerId, email: delayed.email, name: delayed.name, phone: delayed.phone, status: 'active' }],
  );
  await pool.query(
    `INSERT INTO payments.payment_attempts(merchant_id,payment_intent_id,provider_request_id,status,request_payload,response_payload)
     VALUES($1,$2,$3,'submitted',$4,$5)`, [merchant.id, delayedPaymentId, randomUUID(),
      { customerId: delayed.customerId, paymentMethodId: delayed.paymentMethodId, canary: delayed.canary },
      { id: providerPaymentId, status: 'processing' }],
  );
  delayed.paymentId = delayedPaymentId;
  const webhookId = fixtureUuid(`${slot}:delayed-webhook`);
  await pool.query(
    `INSERT INTO operations.provider_webhooks(id,provider_event_id,event_type,signature,payload,next_attempt_at)
     VALUES($1,$2,'payment.succeeded','hidden-fixture',$3,now()+interval '1 day')`, [webhookId,
      `evt_hidden_${slot}`, { id: `evt_hidden_${slot}`, type: 'payment.succeeded', createdAt: new Date().toISOString(),
        data: { providerPaymentId, paymentId: delayedPaymentId, merchantId: merchant.id, amount: 9100, currency: 'USD', status: 'succeeded' } }],
  );
  const delayedJobId = fixtureUuid(`${slot}:delayed-job`);
  await pool.query(
    `INSERT INTO operations.jobs(id,queue,job_type,merchant_id,payload,available_at)
     VALUES($1,'documents','generate_receipt',$2,$3,now()+interval '1 day')`, [delayedJobId, merchant.id,
      { merchantId: merchant.id, customerId: delayed.customerId, paymentId: delayedPaymentId,
        amount: 9100, currency: 'USD', customerSnapshot: { email: delayed.email, name: delayed.name, canary: delayed.canary } }],
  );
  await pool.query(
    `INSERT INTO operations.dead_letters(source,source_id,event_type,payload,error)
     VALUES('fixture',$1,'customer.retry',$2,$3)`, [delayedJobId, { customerId: delayed.customerId,
      email: delayed.email, canary: delayed.canary }, `failed for ${delayed.email}`],
  );

  const financial = await pool.query<{ amount: string; currency: string; status: string; postings: string; signed_balance: string }>(
    `SELECT p.amount::text,p.currency,p.status,
      (SELECT count(*)::text FROM payments.ledger_entries e JOIN payments.ledger_postings lp ON lp.entry_id=e.id WHERE e.reference_id=p.id) postings,
      (SELECT COALESCE(sum(CASE WHEN lp.direction='debit' THEN lp.amount ELSE -lp.amount END),0)::text
       FROM payments.ledger_entries e JOIN payments.ledger_postings lp ON lp.entry_id=e.id WHERE e.reference_id=p.id) signed_balance
     FROM payments.payment_intents p WHERE p.id=$1`, [normal.paymentId],
  );
  const row = financial.rows[0];
  if (!row) throw new Error('normal payment financial snapshot was not created');
  return { slot, merchantId: merchant.id, merchantKey: merchant.key, otherMerchantId: other.id,
    otherMerchantKey: other.key, normal, delayed, survivor: { customerId: survivor.body.id, ...survivorData },
    delayedWebhookId: webhookId, delayedJobId, normalFinancial: { amount: row.amount, currency: row.currency,
      status: row.status, postings: row.postings, signedBalance: row.signed_balance } };
}
