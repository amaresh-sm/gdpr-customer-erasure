import { createHash, randomUUID } from 'node:crypto';
import { api, poll } from './http.js';
import { CUSTOMER_INDEX, fixtureUuid, pool, redis, search } from './clients.js';

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

export interface MerchantApiKeySnapshot {
  merchantId: string;
  keyHash: string;
  label: string;
  scopes: string[];
  revokedAt: string | null;
}

export interface MerchantIdentitySnapshot {
  id: string;
  name: string;
  status: string;
  defaultCurrency: string;
}

export interface MerchantAdminSnapshot {
  id: string;
  merchantId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
}

export interface SurvivorPaymentArtifactSnapshot {
  paymentId: string;
  amount: string;
  currency: string;
  status: string;
  captureCount: string;
  postingCount: string;
  signedBalance: string;
  objectKey: string;
  documentChecksum: string;
  deliveryId: string;
  destination: string;
  template: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  providerMessageId: string | null;
}

export interface MerchantPlatformSurvivor {
  merchant: MerchantIdentitySnapshot;
  admin: MerchantAdminSnapshot;
  secondaryKey: string;
  secondaryApiKey: MerchantApiKeySnapshot;
  payment: SurvivorPaymentArtifactSnapshot;
}

export interface BenchmarkFixture {
  slot: string;
  merchantId: string;
  merchantKey: string;
  merchantApiKey: MerchantApiKeySnapshot;
  platformSurvivor: MerchantPlatformSurvivor;
  otherMerchantId: string;
  otherMerchantKey: string;
  normal: SubjectFixture;
  delayed: SubjectFixture;
  survivor: { customerId: string; email: string; name: string; phone: string; externalReference: string; messageBody: string };
  delayedWebhookId: string;
  delayedJobId: string;
  delayedEmailDeliveryId: string;
  normalFinancial: {
    amount: string;
    currency: string;
    status: string;
    postings: string;
    signedBalance: string;
    invoiceSubtotal: string;
    invoiceTax: string;
    invoiceTotal: string;
    invoiceLineQuantity: string;
    invoiceLineUnitAmount: string;
    invoiceLineTotal: string;
  };
}

async function provisionMerchant(slot: string, suffix: string): Promise<{
  id: string;
  key: string;
  apiKey: MerchantApiKeySnapshot;
  identity: MerchantIdentitySnapshot;
}> {
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
  const apiKey = await pool.query<{ merchant_id: string; key_hash: string; label: string; scopes: string[]; revoked_at: string | null }>(
    `SELECT merchant_id,key_hash,label,scopes,revoked_at FROM platform.api_keys WHERE key_hash=$1`,
    [createHash('sha256').update(key).digest('hex')],
  );
  const snapshot = apiKey.rows[0];
  if (!snapshot) throw new Error('fixture merchant API key was not created');
  const merchant = await pool.query<{ id: string; name: string; status: string; default_currency: string }>(
    `SELECT id,name,status,default_currency FROM platform.merchants WHERE id=$1`, [id],
  );
  const identity = merchant.rows[0];
  if (!identity) throw new Error('fixture merchant was not created');
  for (const [code, name, type] of [['PROCESSOR_CLEARING', 'Processor clearing', 'asset'],
    ['MERCHANT_PAYABLE', 'Merchant payable', 'liability']] as const) {
    await pool.query(
      `INSERT INTO payments.ledger_accounts(merchant_id,code,name,account_type,currency)
       VALUES($1,$2,$3,$4,'USD') ON CONFLICT(merchant_id,code,currency) DO NOTHING`, [id, code, name, type],
    );
  }
  return { id, key, apiKey: {
    merchantId: snapshot.merchant_id, keyHash: snapshot.key_hash, label: snapshot.label,
    scopes: [...snapshot.scopes].sort(), revokedAt: snapshot.revoked_at,
  }, identity: {
    id: identity.id,
    name: identity.name,
    status: identity.status,
    defaultCurrency: identity.default_currency,
  } };
}

async function provisionMerchantAdmin(merchantId: string, slot: string): Promise<MerchantAdminSnapshot> {
  const id = fixtureUuid(`${slot}:merchant-admin`);
  const email = `ops.${slot}@merchant.test`;
  await pool.query(
    `INSERT INTO platform.admins(id,merchant_id,email,display_name,role,status)
     VALUES($1,$2,$3,$4,'admin','active') ON CONFLICT(id) DO NOTHING`,
    [id, merchantId, email, `Operations ${slot}`],
  );
  const result = await pool.query<{
    id: string; merchant_id: string; email: string; display_name: string; role: string; status: string;
  }>(`SELECT id,merchant_id,email,display_name,role,status FROM platform.admins WHERE id=$1`, [id]);
  const admin = result.rows[0];
  if (!admin) throw new Error('fixture merchant administrator was not created');
  return {
    id: admin.id,
    merchantId: admin.merchant_id,
    email: admin.email,
    displayName: admin.display_name,
    role: admin.role,
    status: admin.status,
  };
}

async function provisionSecondaryMerchantKey(merchantId: string, slot: string): Promise<{
  key: string;
  snapshot: MerchantApiKeySnapshot;
}> {
  const key = `pf_hidden_survivor_${createHash('sha256').update(slot).digest('hex').slice(0, 20)}`;
  const keyHash = createHash('sha256').update(key).digest('hex');
  await pool.query(
    `INSERT INTO platform.api_keys(merchant_id,key_hash,label,scopes)
     VALUES($1,$2,'platform survivor verifier',ARRAY['customers:read','payments:read'])
     ON CONFLICT(key_hash) DO UPDATE SET scopes=EXCLUDED.scopes`,
    [merchantId, keyHash],
  );
  const result = await pool.query<{ merchant_id: string; key_hash: string; label: string; scopes: string[]; revoked_at: string | null }>(
    `SELECT merchant_id,key_hash,label,scopes,revoked_at FROM platform.api_keys WHERE key_hash=$1`, [keyHash],
  );
  const apiKey = result.rows[0];
  if (!apiKey) throw new Error('fixture secondary merchant API key was not created');
  return {
    key,
    snapshot: {
      merchantId: apiKey.merchant_id,
      keyHash: apiKey.key_hash,
      label: apiKey.label,
      scopes: [...apiKey.scopes].sort(),
      revokedAt: apiKey.revoked_at,
    },
  };
}

async function createSurvivorPaymentArtifacts(
  apiKey: string,
  merchantId: string,
  survivor: SubjectFixture,
  slot: string,
): Promise<SurvivorPaymentArtifactSnapshot> {
  const payment = await api<{ id: string }>(apiKey, '/v1/payments', {
    method: 'POST',
    expected: 202,
    headers: { 'idempotency-key': `survivor-payment-${slot}` },
    body: {
      customerId: survivor.customerId,
      paymentMethodId: survivor.paymentMethodId,
      amount: 4400,
      currency: 'USD',
      description: `Survivor order ${survivor.canary}`,
    },
  });
  const paymentId = payment.body.id;
  await poll(async () => (await pool.query<{ status: string }>(
    `SELECT status FROM payments.payment_intents WHERE id=$1`, [paymentId],
  )).rows[0]?.status, (status) => status === 'succeeded', 'survivor payment success');
  await poll(async () => Number((await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM operations.document_manifests WHERE metadata->>'paymentId'=$1`, [paymentId],
  )).rows[0]?.count ?? '0'), (count) => count === 1, 'survivor receipt');
  await poll(async () => Number((await pool.query<{ count: string }>(
    `SELECT count(*)::text count
       FROM operations.notifications n
       JOIN operations.email_deliveries d
         ON d.merchant_id=n.merchant_id
        AND d.customer_id IS NOT DISTINCT FROM n.customer_id
        AND d.destination=n.destination
        AND d.template=n.template
       WHERE n.merchant_id=$1 AND n.customer_id=$2 AND n.payload->>'paymentId'=$3 AND d.status='delivered'`,
    [merchantId, survivor.customerId, paymentId],
  )).rows[0]?.count ?? '0'), (count) => count === 1, 'survivor payment notification');

  const result = await pool.query<{
    amount: string; currency: string; status: string; captures: string; postings: string; signed_balance: string;
    object_key: string; checksum: string; delivery_id: string; destination: string; template: string; subject: string;
    text_body: string; html_body: string; provider_message_id: string | null;
  }>(
    `SELECT p.amount::text,p.currency,p.status,
       (SELECT count(*)::text FROM payments.captures c WHERE c.payment_intent_id=p.id) captures,
       (SELECT count(*)::text FROM payments.ledger_entries e JOIN payments.ledger_postings lp ON lp.entry_id=e.id
          WHERE e.reference_id=p.id) postings,
       (SELECT COALESCE(sum(CASE WHEN lp.direction='debit' THEN lp.amount ELSE -lp.amount END),0)::text
          FROM payments.ledger_entries e JOIN payments.ledger_postings lp ON lp.entry_id=e.id WHERE e.reference_id=p.id) signed_balance,
       m.object_key,m.checksum,d.id delivery_id,d.destination,d.template,d.subject,d.text_body,d.html_body,d.provider_message_id
     FROM payments.payment_intents p
     JOIN operations.document_manifests m ON m.metadata->>'paymentId'=p.id::text
     JOIN operations.notifications n ON n.merchant_id=p.merchant_id AND n.customer_id=p.customer_id AND n.payload->>'paymentId'=p.id::text
     JOIN operations.email_deliveries d
       ON d.merchant_id=n.merchant_id
      AND d.customer_id IS NOT DISTINCT FROM n.customer_id
      AND d.destination=n.destination
      AND d.template=n.template
     WHERE p.id=$1 AND d.status='delivered'
     ORDER BY d.created_at DESC LIMIT 1`,
    [paymentId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture survivor payment artifacts were not created');
  return {
    paymentId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    captureCount: row.captures,
    postingCount: row.postings,
    signedBalance: row.signed_balance,
    objectKey: row.object_key,
    documentChecksum: row.checksum,
    deliveryId: row.delivery_id,
    destination: row.destination,
    template: row.template,
    subject: row.subject,
    textBody: row.text_body,
    htmlBody: row.html_body,
    providerMessageId: row.provider_message_id,
  };
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
  const survivor = await createSubject(merchant.key, slot, 'survivor');
  await pool.query(`INSERT INTO customers.support_participants(ticket_id,customer_id) VALUES($1,$2)`,
    [normal.ticketId, survivor.customerId]);
  const survivorMessageBody = `SURVIVOR_MESSAGE_${slot}`;
  await pool.query(
    `INSERT INTO customers.support_messages(merchant_id,ticket_id,author_type,author_id,body)
     VALUES($1,$2,'customer',$3,$4)`, [merchant.id, normal.ticketId, survivor.customerId, survivorMessageBody],
  );
  const admin = await provisionMerchantAdmin(merchant.id, slot);
  const secondaryKey = await provisionSecondaryMerchantKey(merchant.id, slot);
  const survivorPayment = await createSurvivorPaymentArtifacts(merchant.key, merchant.id, survivor, slot);

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
  await poll(async () => Number((await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM operations.email_deliveries
     WHERE merchant_id=$1 AND customer_id=$2 AND status='delivered'`, [merchant.id, normal.customerId])).rows[0]!.count),
  (count) => count >= 1, 'normal Mailpit delivery');
  await poll(async () => await redis.get(`merchant:${merchant.id}:customer:${normal.customerId}`),
  (value) => typeof value === 'string' && value.includes(normal.email), 'normal Redis projection');
  await poll(async () => (await search.exists({ index: CUSTOMER_INDEX, id: `${merchant.id}:${normal.customerId}` })).body,
  (exists) => exists === true, 'normal OpenSearch projection');

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
  const delayedEmailDeliveryId = fixtureUuid(`${slot}:delayed-email-delivery`);
  await pool.query(
    `INSERT INTO operations.email_deliveries
     (id,merchant_id,customer_id,destination,template,subject,text_body,html_body,available_at)
     VALUES($1,$2,$3,$4,'payment-receipt',$5,$6,$7,now()+interval '1 day')`,
    [delayedEmailDeliveryId, merchant.id, delayed.customerId, delayed.email, `PayFlow receipt for ${delayed.name}`,
      `Delayed receipt ${delayed.email} ${delayed.canary}`, `<p>${delayed.name} ${delayed.canary}</p>`],
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
  const invoiceFinancial = await pool.query<{
    subtotal: string; tax: string; total: string; quantity: string; unit_amount: string; line_total: string;
  }>(
    `SELECT i.subtotal::text,i.tax::text,i.total::text,l.quantity::text,l.unit_amount::text,l.total::text line_total
       FROM payments.invoices i JOIN payments.invoice_lines l ON l.invoice_id=i.id WHERE i.id=$1 ORDER BY l.id LIMIT 1`,
    [normal.invoiceId],
  );
  const invoice = invoiceFinancial.rows[0];
  if (!invoice) throw new Error('normal invoice financial snapshot was not created');
  return { slot, merchantId: merchant.id, merchantKey: merchant.key, merchantApiKey: merchant.apiKey,
    platformSurvivor: { merchant: merchant.identity, admin, secondaryKey: secondaryKey.key,
      secondaryApiKey: secondaryKey.snapshot, payment: survivorPayment }, otherMerchantId: other.id,
    otherMerchantKey: other.key, normal, delayed, survivor: { ...survivor, messageBody: survivorMessageBody },
    delayedWebhookId: webhookId, delayedJobId, delayedEmailDeliveryId, normalFinancial: { amount: row.amount, currency: row.currency,
      status: row.status, postings: row.postings, signedBalance: row.signed_balance,
      invoiceSubtotal: invoice.subtotal, invoiceTax: invoice.tax, invoiceTotal: invoice.total,
      invoiceLineQuantity: invoice.quantity, invoiceLineUnitAmount: invoice.unit_amount, invoiceLineTotal: invoice.line_total } };
}
