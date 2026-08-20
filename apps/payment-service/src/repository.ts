import { pool } from '../../../packages/database/src/pool.js';

export class PaymentRepository {
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
