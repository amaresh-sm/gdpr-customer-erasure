import { pool, transaction } from '../../../packages/database/src/pool.js';

export interface ProviderPaymentInput {
  paymentId: string;
  merchantId: string;
  amount: number;
  currency: string;
  paymentMethodId: string;
  outcome: 'succeeded' | 'declined' | 'timeout';
  deliveryMode: 'standard' | 'duplicate' | 'stale_processing';
  webhookUrl: string;
}

export interface ProviderRefundInput {
  refundId: string;
  merchantId: string;
  amount: number;
  currency: string;
  reason: string;
  webhookUrl: string;
}

export interface PaymentCallback {
  id: string;
  payment_id: string;
  merchant_id: string;
  amount: string;
  currency: string;
  webhook_url: string;
  webhook_attempts: number;
  event_type: 'payment.succeeded' | 'payment.failed';
  delivery_mode: 'standard' | 'duplicate' | 'stale_processing';
  failure_code: string | null;
}

export interface RefundCallback {
  id: string;
  provider_payment_id: string;
  refund_id: string;
  payment_id: string;
  merchant_id: string;
  amount: string;
  currency: string;
  reason: string;
  webhook_url: string;
  webhook_attempts: number;
}

export interface SettlementPayment {
  provider_payment_id: string;
  payment_id: string;
  merchant_id: string;
  amount: string;
  currency: string;
}

export class ProviderSandboxRepository {
  async createPayment(id: string, input: ProviderPaymentInput, delayMs: number): Promise<void> {
    await pool.query(
      `INSERT INTO provider_sandbox.payment_intents
       (id,payment_id,merchant_id,amount,currency,payment_method_id,webhook_url,status,outcome,delivery_mode,failure_code,available_at,next_delivery_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'processing',$8,$9,$10,now()+($11 || ' milliseconds')::interval,
              now()+($11 || ' milliseconds')::interval)`,
      [id, input.paymentId, input.merchantId, input.amount, input.currency, input.paymentMethodId, input.webhookUrl,
        input.outcome, input.deliveryMode, input.outcome === 'declined' ? 'card_declined' : null, delayMs],
    );
  }

  async paymentIsRefundable(providerPaymentId: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM provider_sandbox.payment_intents WHERE id=$1 AND status='succeeded'`,
      [providerPaymentId],
    );
    return Boolean(result.rowCount);
  }

  async createRefund(id: string, providerPaymentId: string, input: ProviderRefundInput, delayMs: number): Promise<void> {
    await pool.query(
      `INSERT INTO provider_sandbox.refunds
       (id,provider_payment_id,refund_id,merchant_id,amount,currency,reason,webhook_url,status,available_at,next_delivery_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',now()+($9 || ' milliseconds')::interval,
              now()+($9 || ' milliseconds')::interval)`,
      [id, providerPaymentId, input.refundId, input.merchantId, input.amount, input.currency, input.reason, input.webhookUrl, delayMs],
    );
  }

  async claimPaymentCallback(): Promise<PaymentCallback | undefined> {
    return await transaction(async (client) => {
      const result = await client.query<PaymentCallback>(
        `UPDATE provider_sandbox.payment_intents
         SET status=CASE WHEN outcome='declined' THEN 'failed' ELSE 'succeeded' END,webhook_attempts=webhook_attempts+1,
             next_delivery_at=now()+interval '30 seconds',last_delivery_error=NULL,updated_at=now()
         WHERE id=(SELECT id FROM provider_sandbox.payment_intents
           WHERE webhook_delivered_at IS NULL AND available_at<=now() AND next_delivery_at<=now()
           ORDER BY next_delivery_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id,payment_id,merchant_id,amount::text,currency,webhook_url,webhook_attempts,
           CASE WHEN outcome='declined' THEN 'payment.failed' ELSE 'payment.succeeded' END event_type,
           delivery_mode,failure_code`,
      );
      return result.rows[0];
    });
  }

  async claimRefundCallback(): Promise<RefundCallback | undefined> {
    return await transaction(async (client) => {
      const result = await client.query<RefundCallback>(
        `UPDATE provider_sandbox.refunds r
         SET status='succeeded',webhook_attempts=r.webhook_attempts+1,
             next_delivery_at=now()+interval '30 seconds',last_delivery_error=NULL,updated_at=now()
         FROM provider_sandbox.payment_intents p
         WHERE r.id=(SELECT id FROM provider_sandbox.refunds
           WHERE webhook_delivered_at IS NULL AND webhook_url IS NOT NULL
             AND available_at<=now() AND next_delivery_at<=now()
           ORDER BY next_delivery_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
           AND p.id=r.provider_payment_id
         RETURNING r.id,r.provider_payment_id,r.refund_id,p.payment_id,r.merchant_id,r.amount::text,
                   r.currency,r.reason,r.webhook_url,r.webhook_attempts`,
      );
      return result.rows[0];
    });
  }

  async markPaymentCallbackDelivered(id: string): Promise<void> {
    await pool.query(
      `UPDATE provider_sandbox.payment_intents
       SET webhook_delivered_at=now(),last_delivery_error=NULL,updated_at=now() WHERE id=$1`,
      [id],
    );
  }

  async markRefundCallbackDelivered(id: string): Promise<void> {
    await pool.query(
      `UPDATE provider_sandbox.refunds
       SET webhook_delivered_at=now(),last_delivery_error=NULL,updated_at=now() WHERE id=$1`,
      [id],
    );
  }

  async deferPaymentCallback(id: string, attempts: number, error: unknown): Promise<void> {
    await this.defer('payment_intents', id, attempts, error);
  }

  async deferRefundCallback(id: string, attempts: number, error: unknown): Promise<void> {
    await this.defer('refunds', id, attempts, error);
  }

  async settlements(): Promise<SettlementPayment[]> {
    const result = await pool.query<SettlementPayment>(
      `SELECT id provider_payment_id,payment_id,merchant_id,amount::text,currency
       FROM provider_sandbox.payment_intents WHERE status='succeeded' ORDER BY created_at`,
    );
    return result.rows;
  }

  private async defer(table: 'payment_intents' | 'refunds', id: string, attempts: number, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    const delay = Math.min(300, 2 ** Math.min(attempts, 8));
    await pool.query(
      `UPDATE provider_sandbox.${table}
       SET next_delivery_at=now()+($2 || ' seconds')::interval,last_delivery_error=$3,updated_at=now()
       WHERE id=$1`,
      [id, delay, message],
    );
  }
}
