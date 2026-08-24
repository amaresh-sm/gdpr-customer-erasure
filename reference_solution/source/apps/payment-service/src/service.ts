import { v4 as uuid } from 'uuid';
import type { CreatePayment, CreateRefund } from '../../../packages/contracts/src/domain.js';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { providerSandboxBehavior } from '../../../packages/payments/src/provider-sandbox-behavior.js';
import { erasedSubjectByAnyId } from '../../../packages/privacy/src/subjects.js';
import { completeIdempotency, requestHash, reserveIdempotency } from './idempotency.js';

type CustomerSnapshot = { id: string; email: string; name: string; phone?: string | null; status: string };

export class PaymentService {
  async create(
    merchantId: string, authorization: string, idempotencyKey: string, input: CreatePayment,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const hash = requestHash(input);
    const customer = await this.fetchCustomer(authorization, input.customerId);
    if (customer.status !== 'active') throw Object.assign(new Error('customer is not active'), { statusCode: 409 });
    const paymentMethod = await this.fetchPaymentMethod(merchantId, input.customerId, input.paymentMethodId);
    const sandboxBehavior = providerSandboxBehavior(paymentMethod.providerToken);
    const correlationId = uuid();
    const prepared = await transaction(async (client) => {
      const replay = await reserveIdempotency(client, merchantId, 'create-payment', idempotencyKey, hash);
      if (replay) return { replay };
      const intent = await client.query<{ id: string }>(
        `INSERT INTO payments.payment_intents
         (merchant_id,customer_id,payment_method_id,amount,currency,status,description,customer_snapshot)
         VALUES($1,$2,$3,$4,$5,'processing',$6,$7) RETURNING id`,
        [merchantId, input.customerId, input.paymentMethodId, input.amount, input.currency, input.description ?? null, customer],
      );
      const paymentId = intent.rows[0]!.id;
      const providerRequestId = uuid();
      await client.query(
        `INSERT INTO payments.payment_attempts
         (merchant_id,payment_intent_id,provider_request_id,status,request_payload)
         VALUES($1,$2,$3,'pending',$4)`, [merchantId, paymentId, providerRequestId, input],
      );
      await addOutboxEvent(client, { eventType: EVENT_TYPES.PAYMENT_INTENT_CREATED, aggregateType: 'payment_intent',
        aggregateId: paymentId, merchantId, correlationId, payload: { paymentId, customerId: input.customerId,
          amount: input.amount, currency: input.currency, customerEmail: customer.email } });
      return { paymentId, providerRequestId };
    });
    if ('replay' in prepared) return { status: prepared.replay!.status, body: prepared.replay!.body as Record<string, unknown> };

    try {
      const response = await fetch(`${config().PROCESSOR_URL}/v1/payment-intents`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': prepared.providerRequestId! },
        body: JSON.stringify({ merchantId, paymentId: prepared.paymentId, amount: input.amount, currency: input.currency,
          paymentMethodId: input.paymentMethodId, outcome: sandboxBehavior.outcome,
          deliveryMode: sandboxBehavior.deliveryMode, webhookUrl: config().PROCESSOR_WEBHOOK_URL }),
      });
      if (!response.ok) throw new Error(`processor returned ${response.status}`);
      const provider = await response.json() as { id: string; status: string };
      const body = { id: prepared.paymentId!, status: 'processing', amount: input.amount, currency: input.currency,
        customerId: input.customerId, providerPaymentId: provider.id };
      await transaction(async (client) => {
        await client.query(`UPDATE payments.payment_intents SET provider_payment_id=$2,updated_at=now() WHERE id=$1`, [prepared.paymentId, provider.id]);
        await client.query(`UPDATE payments.payment_attempts SET status='submitted',response_payload=$2 WHERE provider_request_id=$1`, [prepared.providerRequestId, provider]);
        await addOutboxEvent(client, { eventType: EVENT_TYPES.PAYMENT_PROCESSING, aggregateType: 'payment_intent',
          aggregateId: prepared.paymentId!, merchantId, correlationId, payload: body });
        await completeIdempotency(client, merchantId, 'create-payment', idempotencyKey, 202, body);
      });
      return { status: 202, body };
    } catch (error) {
      const body = { id: prepared.paymentId!, status: 'failed', error: 'processor_unavailable' };
      await transaction(async (client) => {
        await client.query(`UPDATE payments.payment_intents SET status='failed',updated_at=now() WHERE id=$1`, [prepared.paymentId]);
        await client.query(`UPDATE payments.payment_attempts SET status='failed',failure_code='processor_unavailable',failure_message=$2 WHERE provider_request_id=$1`,
          [prepared.providerRequestId, error instanceof Error ? error.message : String(error)]);
        await addOutboxEvent(client, { eventType: EVENT_TYPES.PAYMENT_FAILED, aggregateType: 'payment_intent',
          aggregateId: prepared.paymentId!, merchantId, correlationId, payload: body });
        await completeIdempotency(client, merchantId, 'create-payment', idempotencyKey, 502, body);
      });
      return { status: 502, body };
    }
  }

  async refund(merchantId: string, paymentId: string, input: CreateRefund): Promise<Record<string, unknown>> {
    const payment = await pool.query<{ amount: string; currency: string; status: string; provider_payment_id: string; customer_id: string; customer_snapshot: CustomerSnapshot }>(
      `SELECT amount,currency,status,provider_payment_id,customer_id,customer_snapshot FROM payments.payment_intents
       WHERE merchant_id=$1 AND id=$2`, [merchantId, paymentId],
    );
    const row = payment.rows[0];
    if (!row) throw Object.assign(new Error('payment not found'), { statusCode: 404 });
    if (row.status !== 'succeeded' && row.status !== 'partially_refunded') throw Object.assign(new Error('payment is not refundable'), { statusCode: 409 });
    const refunded = await pool.query<{ total: string }>(
      `SELECT COALESCE(sum(amount),0)::text total FROM payments.refunds
       WHERE payment_intent_id=$1 AND status IN ('pending','succeeded')`, [paymentId],
    );
    if (Number(refunded.rows[0]!.total) + input.amount > Number(row.amount)) {
      throw Object.assign(new Error('refund exceeds captured amount'), { statusCode: 409 });
    }
    const refundId = uuid();
    const suppression = await erasedSubjectByAnyId(merchantId, row.customer_id);
    const reason = suppression ? '[redacted]' : input.reason;
    const customerEmail = suppression ? null : row.customer_snapshot.email;
    await pool.query(
      `INSERT INTO payments.refunds(id,merchant_id,payment_intent_id,amount,reason,status,customer_email)
       VALUES($1,$2,$3,$4,$5,'pending',$6)`, [refundId, merchantId, paymentId, input.amount, reason, customerEmail],
    );
    try {
      const response = await fetch(`${config().PROCESSOR_URL}/v1/payment-intents/${row.provider_payment_id}/refunds`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': refundId },
        body: JSON.stringify({ refundId, paymentId, merchantId, amount: input.amount, currency: row.currency,
          reason, webhookUrl: config().PROCESSOR_WEBHOOK_URL }),
      });
      if (!response.ok) throw new Error(`processor returned ${response.status}`);
      const provider = await response.json() as { id: string };
      await pool.query(`UPDATE payments.refunds SET provider_refund_id=$2 WHERE id=$1`, [refundId, provider.id]);
      return { id: refundId, paymentId, amount: input.amount, status: 'pending', providerRefundId: provider.id };
    } catch (error) {
      await pool.query(`UPDATE payments.refunds SET status='failed' WHERE id=$1`, [refundId]);
      throw Object.assign(new Error('processor unavailable'), { statusCode: 502, cause: error });
    }
  }

  private async fetchCustomer(authorization: string, customerId: string): Promise<CustomerSnapshot> {
    const response = await fetch(`${config().CUSTOMER_SERVICE_URL}/v1/customers/${customerId}`, { headers: { authorization } });
    if (response.status === 404) throw Object.assign(new Error('customer not found'), { statusCode: 422 });
    if (!response.ok) throw Object.assign(new Error('customer service unavailable'), { statusCode: 503 });
    return await response.json() as CustomerSnapshot;
  }

  private async fetchPaymentMethod(merchantId: string, customerId: string, paymentMethodId: string): Promise<{ providerToken: string }> {
    const response = await fetch(`${config().CUSTOMER_SERVICE_URL}/internal/customers/${customerId}/payment-methods/${paymentMethodId}`,
      { headers: { 'x-internal-service-token': config().INTERNAL_SERVICE_TOKEN, 'x-merchant-id': merchantId } });
    if (response.status === 404) throw Object.assign(new Error('payment method not found for customer'), { statusCode: 422 });
    if (!response.ok) throw Object.assign(new Error('customer service unavailable'), { statusCode: 503 });
    const method = await response.json() as { provider_token?: unknown };
    if (typeof method.provider_token !== 'string') throw Object.assign(new Error('payment method is invalid'), { statusCode: 422 });
    return { providerToken: method.provider_token };
  }
}
