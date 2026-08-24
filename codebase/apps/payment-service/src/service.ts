import { v4 as uuid } from 'uuid';
import type { CreatePayment, CreateRefund } from '../../../packages/contracts/src/domain.js';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { PaymentProviderClient } from '../../../packages/payments/src/provider-client.js';
import { providerSandboxBehavior } from '../../../packages/payments/src/provider-sandbox-behavior.js';
import { completeIdempotency, requestHash, reserveIdempotency } from './idempotency.js';
import { PaymentRepository, type CustomerSnapshot } from './repository.js';

export class PaymentService {
  private readonly provider = new PaymentProviderClient();

  constructor(private readonly repository = new PaymentRepository()) {}

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
      const providerRequestId = uuid();
      const prepared = await this.repository.preparePayment(client, merchantId, providerRequestId, input, customer);
      await addOutboxEvent(client, {
        eventType: EVENT_TYPES.PAYMENT_INTENT_CREATED, aggregateType: 'payment_intent',
        aggregateId: prepared.paymentId, merchantId, correlationId, payload: {
          paymentId: prepared.paymentId, customerId: input.customerId,
          amount: input.amount, currency: input.currency, customerEmail: customer.email
        }
      });
      return prepared;
    });
    if ('replay' in prepared) return { status: prepared.replay!.status, body: prepared.replay!.body as Record<string, unknown> };

    try {
      const provider = await this.provider.createPaymentIntent({
        requestId: prepared.providerRequestId!,
        merchantId,
        paymentId: prepared.paymentId!,
        amount: input.amount,
        currency: input.currency,
        paymentMethodId: input.paymentMethodId,
        outcome: sandboxBehavior.outcome,
        deliveryMode: sandboxBehavior.deliveryMode,
        webhookUrl: config().PROCESSOR_WEBHOOK_URL,
      });
      const body = {
        id: prepared.paymentId!, status: 'processing', amount: input.amount, currency: input.currency,
        customerId: input.customerId, providerPaymentId: provider.id
      };
      await transaction(async (client) => {
        await this.repository.markProviderSubmitted(
          client, prepared.paymentId!, prepared.providerRequestId!, provider.id, provider,
        );
        await addOutboxEvent(client, {
          eventType: EVENT_TYPES.PAYMENT_PROCESSING, aggregateType: 'payment_intent',
          aggregateId: prepared.paymentId!, merchantId, correlationId, payload: body
        });
        await completeIdempotency(client, merchantId, 'create-payment', idempotencyKey, 202, body);
      });
      return { status: 202, body };
    } catch (error) {
      const body = { id: prepared.paymentId!, status: 'failed', error: 'processor_unavailable' };
      await transaction(async (client) => {
        await this.repository.markProviderFailed(
          client,
          prepared.paymentId!,
          prepared.providerRequestId!,
          error instanceof Error ? error.message : String(error),
        );
        await addOutboxEvent(client, {
          eventType: EVENT_TYPES.PAYMENT_FAILED, aggregateType: 'payment_intent',
          aggregateId: prepared.paymentId!, merchantId, correlationId, payload: body
        });
        await completeIdempotency(client, merchantId, 'create-payment', idempotencyKey, 502, body);
      });
      return { status: 502, body };
    }
  }

  async refund(merchantId: string, paymentId: string, input: CreateRefund): Promise<Record<string, unknown>> {
    const row = await this.repository.findRefundable(merchantId, paymentId);
    if (!row) throw Object.assign(new Error('payment not found'), { statusCode: 404 });
    if (row.status !== 'succeeded' && row.status !== 'partially_refunded') throw Object.assign(new Error('payment is not refundable'), { statusCode: 409 });
    if (await this.repository.refundableAmountAlreadyUsed(paymentId) + input.amount > Number(row.amount)) {
      throw Object.assign(new Error('refund exceeds captured amount'), { statusCode: 409 });
    }
    const refundId = uuid();
    await this.repository.createRefund(refundId, merchantId, paymentId, input, row.customer_snapshot.email);
    try {
      const provider = await this.provider.createRefund({
        requestId: refundId,
        refundId,
        paymentId,
        merchantId,
        providerPaymentId: row.provider_payment_id,
        amount: input.amount,
        currency: row.currency,
        reason: input.reason,
        webhookUrl: config().PROCESSOR_WEBHOOK_URL,
      });
      await this.repository.attachProviderRefund(refundId, provider.id);
      return { id: refundId, paymentId, amount: input.amount, status: 'pending', providerRefundId: provider.id };
    } catch (error) {
      await this.repository.markRefundFailed(refundId);
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
