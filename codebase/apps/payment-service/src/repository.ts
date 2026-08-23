import type { PoolClient } from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import type { CreatePayment, CreateRefund } from '../../../packages/contracts/src/domain.js';

export type CustomerSnapshot = {
  id: string;
  email: string;
  name: string;
  phone?: string | null;
  status: string;
};

export interface PreparedPayment {
  paymentId: string;
  providerRequestId: string;
}

export interface RefundablePayment {
  amount: string;
  currency: string;
  status: string;
  provider_payment_id: string;
  customer_snapshot: CustomerSnapshot;
}

export class PaymentRepository {
  async preparePayment(
    client: PoolClient,
    merchantId: string,
    providerRequestId: string,
    input: CreatePayment,
    customer: CustomerSnapshot,
  ): Promise<PreparedPayment> {
    const intent = await client.query<{ id: string }>(
      `INSERT INTO payments.payment_intents
       (merchant_id,customer_id,payment_method_id,amount,currency,status,description,customer_snapshot)
       VALUES($1,$2,$3,$4,$5,'processing',$6,$7) RETURNING id`,
      [merchantId, input.customerId, input.paymentMethodId, input.amount, input.currency, input.description ?? null, customer],
    );
    const paymentId = intent.rows[0]!.id;
    await client.query(
      `INSERT INTO payments.payment_attempts
       (merchant_id,payment_intent_id,provider_request_id,status,request_payload)
       VALUES($1,$2,$3,'pending',$4)`,
      [merchantId, paymentId, providerRequestId, input],
    );
    return { paymentId, providerRequestId };
  }

  async markProviderSubmitted(
    client: PoolClient,
    paymentId: string,
    providerRequestId: string,
    providerPaymentId: string,
    providerResponse: unknown,
  ): Promise<void> {
    await client.query(
      `UPDATE payments.payment_intents SET provider_payment_id=$2,updated_at=now() WHERE id=$1`,
      [paymentId, providerPaymentId],
    );
    await client.query(
      `UPDATE payments.payment_attempts SET status='submitted',response_payload=$2 WHERE provider_request_id=$1`,
      [providerRequestId, providerResponse],
    );
  }

  async markProviderFailed(
    client: PoolClient,
    paymentId: string,
    providerRequestId: string,
    message: string,
  ): Promise<void> {
    await client.query(
      `UPDATE payments.payment_intents SET status='failed',updated_at=now() WHERE id=$1`,
      [paymentId],
    );
    await client.query(
      `UPDATE payments.payment_attempts
       SET status='failed',failure_code='processor_unavailable',failure_message=$2
       WHERE provider_request_id=$1`,
      [providerRequestId, message],
    );
  }

  async findRefundable(merchantId: string, paymentId: string): Promise<RefundablePayment | undefined> {
    const result = await pool.query<RefundablePayment>(
      `SELECT amount,currency,status,provider_payment_id,customer_snapshot
       FROM payments.payment_intents WHERE merchant_id=$1 AND id=$2`,
      [merchantId, paymentId],
    );
    return result.rows[0];
  }

  async refundableAmountAlreadyUsed(paymentId: string): Promise<number> {
    const result = await pool.query<{ total: string }>(
      `SELECT COALESCE(sum(amount),0)::text total FROM payments.refunds
       WHERE payment_intent_id=$1 AND status IN ('pending','succeeded')`,
      [paymentId],
    );
    return Number(result.rows[0]!.total);
  }

  async createRefund(
    refundId: string,
    merchantId: string,
    paymentId: string,
    input: CreateRefund,
    customerEmail: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO payments.refunds(id,merchant_id,payment_intent_id,amount,reason,status,customer_email)
       VALUES($1,$2,$3,$4,$5,'pending',$6)`,
      [refundId, merchantId, paymentId, input.amount, input.reason, customerEmail],
    );
  }

  async attachProviderRefund(refundId: string, providerRefundId: string): Promise<void> {
    await pool.query(`UPDATE payments.refunds SET provider_refund_id=$2 WHERE id=$1`, [refundId, providerRefundId]);
  }

  async markRefundFailed(refundId: string): Promise<void> {
    await pool.query(`UPDATE payments.refunds SET status='failed' WHERE id=$1`, [refundId]);
  }

  async find(merchantId: string, id: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query(
      `SELECT p.*,COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id',r.id,'amount',r.amount,'status',r.status,'reason',r.reason))
       FILTER (WHERE r.id IS NOT NULL),'[]') refunds
       FROM payments.payment_intents p LEFT JOIN payments.refunds r ON r.payment_intent_id=p.id
       WHERE p.merchant_id=$1 AND p.id=$2 GROUP BY p.id`, [merchantId, id],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  async list(merchantId: string, customerId: string | undefined, limit: number): Promise<Record<string, unknown>[]> {
    const result = await pool.query(
      `SELECT id,customer_id,amount,currency,status,description,provider_payment_id,created_at,updated_at
       FROM payments.payment_intents WHERE merchant_id=$1 AND ($2::uuid IS NULL OR customer_id=$2)
       ORDER BY created_at DESC LIMIT $3`, [merchantId, customerId ?? null, limit],
    );
    return result.rows as Record<string, unknown>[];
  }
}
