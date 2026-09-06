import type pg from 'pg';
import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { advisoryLock, transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { postJournal } from '../../payment-service/src/ledger.js';

type ProviderEvent = { id: string; type: string; data: Record<string, unknown> };

export async function processProviderEvent(webhookId: string, event: ProviderEvent): Promise<void> {
  await transaction(async (client) => {
    await advisoryLock(client, String(event.data.providerPaymentId ?? event.id));
    if (event.type === 'payment.processing') await paymentProcessing(client, event);
    else if (event.type === 'payment.succeeded') await paymentSucceeded(client, event);
    else if (event.type === 'payment.failed') await paymentFailed(client, event);
    else if (event.type === 'refund.succeeded') await refundSucceeded(client, event);
    else throw new Error(`unsupported provider event ${event.type}`);
    await client.query(`UPDATE operations.provider_webhooks SET status='processed',processed_at=now() WHERE id=$1`, [webhookId]);
  });
}

/** An obsolete processing webhook is accepted but must never regress terminal payment state. */
async function paymentProcessing(client: pg.PoolClient, event: ProviderEvent): Promise<void> {
  const paymentId = String(event.data.paymentId);
  const result = await client.query(`SELECT id FROM payments.payment_intents WHERE id=$1 FOR UPDATE`, [paymentId]);
  if (!result.rowCount) throw new Error(`payment ${paymentId} not found`);
}

async function paymentSucceeded(client: pg.PoolClient, event: ProviderEvent): Promise<void> {
  const paymentId = String(event.data.paymentId);
  const payment = await client.query<{ id: string; merchant_id: string; customer_id: string; amount: string; currency: string; status: string; customer_snapshot: Record<string, unknown> }>(
    `SELECT id,merchant_id,customer_id,amount,currency,status,customer_snapshot FROM payments.payment_intents WHERE id=$1 FOR UPDATE`, [paymentId],
  );
  const row = payment.rows[0];
  if (!row) throw new Error(`payment ${paymentId} not found`);
  if (row.status === 'succeeded') return;
  const providerCaptureId = `cap_${String(event.data.providerPaymentId)}`;
  await client.query(`UPDATE payments.payment_intents SET status='succeeded',version=version+1,updated_at=now() WHERE id=$1`, [paymentId]);
  await client.query(`UPDATE payments.payment_attempts SET status='succeeded' WHERE payment_intent_id=$1 AND status='submitted'`, [paymentId]);
  await client.query(
    `INSERT INTO payments.captures(merchant_id,payment_intent_id,provider_capture_id,amount,status)
     VALUES($1,$2,$3,$4,'succeeded') ON CONFLICT(provider_capture_id) DO NOTHING`,
    [row.merchant_id, paymentId, providerCaptureId, row.amount],
  );
  await postJournal(client, { merchantId: row.merchant_id, referenceType: 'capture', referenceId: paymentId,
    description: `Capture ${paymentId}`, currency: row.currency, postings: [
      { accountCode: 'PROCESSOR_CLEARING', direction: 'debit', amount: Number(row.amount) },
      { accountCode: 'MERCHANT_PAYABLE', direction: 'credit', amount: Number(row.amount) },
    ] });
  await client.query(
    `INSERT INTO operations.jobs(queue,job_type,merchant_id,payload)
     VALUES('documents','generate_receipt',$1,$2)`, [row.merchant_id, { merchantId: row.merchant_id,
      customerId: row.customer_id, paymentId, amount: Number(row.amount), currency: row.currency,
      customerSnapshot: row.customer_snapshot }],
  );
  const correlationId = uuid();
  await addOutboxEvent(client, { eventType: EVENT_TYPES.PAYMENT_SUCCEEDED, aggregateType: 'payment_intent', aggregateId: paymentId,
    merchantId: row.merchant_id, correlationId, payload: { paymentId, customerId: row.customer_id, amount: Number(row.amount),
      currency: row.currency, customerEmail: row.customer_snapshot.email, receiptStatus: 'pending' } });
}

async function paymentFailed(client: pg.PoolClient, event: ProviderEvent): Promise<void> {
  const paymentId = String(event.data.paymentId);
  const result = await client.query<{ merchant_id: string; customer_id: string; customer_snapshot: Record<string, unknown> }>(
    `UPDATE payments.payment_intents SET status='failed',version=version+1,updated_at=now()
     WHERE id=$1 AND status='processing' RETURNING merchant_id,customer_id,customer_snapshot`, [paymentId],
  );
  if (!result.rows[0]) return;
  await client.query(`UPDATE payments.payment_attempts SET status='failed',failure_code=$2 WHERE payment_intent_id=$1`,
    [paymentId, event.data.failureCode ?? 'unknown']);
  await addOutboxEvent(client, { eventType: EVENT_TYPES.PAYMENT_FAILED, aggregateType: 'payment_intent', aggregateId: paymentId,
    merchantId: result.rows[0].merchant_id, correlationId: uuid(), payload: { paymentId,
      customerId: result.rows[0].customer_id, customerEmail: result.rows[0].customer_snapshot.email,
      failureCode: event.data.failureCode ?? 'unknown' } });
}

async function refundSucceeded(client: pg.PoolClient, event: ProviderEvent): Promise<void> {
  const refundId = String(event.data.refundId);
  const refund = await client.query<{ merchant_id: string; payment_intent_id: string; amount: string; customer_email: string; currency: string; customer_id: string; payment_amount: string }>(
    `SELECT r.merchant_id,r.payment_intent_id,r.amount,r.customer_email,p.currency,p.customer_id,p.amount payment_amount
     FROM payments.refunds r JOIN payments.payment_intents p ON p.id=r.payment_intent_id
     WHERE r.id=$1 FOR UPDATE`, [refundId],
  );
  const row = refund.rows[0];
  if (!row) throw new Error(`refund ${refundId} not found`);
  const changed = await client.query(`UPDATE payments.refunds SET status='succeeded',provider_refund_id=COALESCE(provider_refund_id,$2)
    WHERE id=$1 AND status='pending'`, [refundId, event.data.providerRefundId]);
  if (!changed.rowCount) return;
  const total = await client.query<{ total: string }>(`SELECT sum(amount)::text total FROM payments.refunds WHERE payment_intent_id=$1 AND status='succeeded'`, [row.payment_intent_id]);
  const status = Number(total.rows[0]!.total) === Number(row.payment_amount) ? 'refunded' : 'partially_refunded';
  await client.query(`UPDATE payments.payment_intents SET status=$2,version=version+1,updated_at=now() WHERE id=$1`, [row.payment_intent_id, status]);
  await postJournal(client, { merchantId: row.merchant_id, referenceType: 'refund', referenceId: refundId,
    description: `Refund ${refundId}`, currency: row.currency, postings: [
      { accountCode: 'MERCHANT_PAYABLE', direction: 'debit', amount: Number(row.amount) },
      { accountCode: 'PROCESSOR_CLEARING', direction: 'credit', amount: Number(row.amount) },
    ] });
  await addOutboxEvent(client, { eventType: EVENT_TYPES.PAYMENT_REFUNDED, aggregateType: 'refund', aggregateId: refundId,
    merchantId: row.merchant_id, correlationId: uuid(), payload: { refundId, paymentId: row.payment_intent_id,
      customerId: row.customer_id, customerEmail: row.customer_email, amount: Number(row.amount), currency: row.currency, paymentStatus: status } });
}
