import type { PoolClient } from 'pg';
import { pool } from '../../../packages/database/src/pool.js';

export interface ProviderTransaction {
  providerPaymentId: string;
  paymentId: string;
  merchantId: string;
  amount: number;
  currency: string;
}

export interface ReconciledPayment {
  id: string;
  provider_payment_id: string;
  amount: string;
}

export class ReconciliationRepository {
  async storeSettlement(
    client: PoolClient,
    merchantId: string,
    settlementId: string,
    gross: number,
    currency: string,
    feed: unknown,
  ): Promise<void> {
    await client.query(
      `INSERT INTO payments.provider_settlements
       (merchant_id,provider_settlement_id,period_start,period_end,gross,fees,net,currency,raw_payload)
       VALUES($1,$2,now()-interval '1 day',now(),$3,0,$3,$4,$5)`,
      [merchantId, settlementId, gross, currency, feed],
    );
  }

  async startRun(client: PoolClient, runId: string, merchantId: string): Promise<void> {
    await client.query(
      `INSERT INTO payments.reconciliation_runs(id,merchant_id,status) VALUES($1,$2,'running')`,
      [runId, merchantId],
    );
  }

  async listPayments(client: PoolClient, merchantId: string): Promise<ReconciledPayment[]> {
    const result = await client.query<ReconciledPayment>(
      `SELECT p.id,p.provider_payment_id,p.amount::text FROM payments.payment_intents p
       WHERE p.merchant_id=$1 AND p.status IN ('succeeded','partially_refunded','refunded')`,
      [merchantId],
    );
    return result.rows;
  }

  async latestSettlement(client: PoolClient, merchantId: string): Promise<ProviderTransaction[]> {
    const result = await client.query<{ raw_payload: { transactions: ProviderTransaction[] } }>(
      `SELECT raw_payload FROM payments.provider_settlements
       WHERE merchant_id=$1 ORDER BY imported_at DESC LIMIT 1`,
      [merchantId],
    );
    return result.rows[0]?.raw_payload.transactions ?? [];
  }

  async addItem(
    client: PoolClient,
    runId: string,
    payment: ReconciledPayment,
    providerAmount: number | null,
  ): Promise<void> {
    const ledgerAmount = Number(payment.amount);
    await client.query(
      `INSERT INTO payments.reconciliation_items
       (run_id,reference_type,reference_id,ledger_amount,provider_amount,status,detail)
       VALUES($1,'payment',$2,$3,$4,$5,$6)`,
      [
        runId,
        payment.id,
        ledgerAmount,
        providerAmount,
        providerAmount === ledgerAmount ? 'matched' : 'mismatched',
        { providerPaymentId: payment.provider_payment_id },
      ],
    );
  }

  async completeRun(
    client: PoolClient,
    runId: string,
    ledgerTotal: number,
    providerTotal: number,
  ): Promise<void> {
    const discrepancy = providerTotal - ledgerTotal;
    await client.query(
      `UPDATE payments.reconciliation_runs
       SET status=$2,ledger_total=$3,provider_total=$4,discrepancy=$5,completed_at=now() WHERE id=$1`,
      [runId, discrepancy === 0 ? 'matched' : 'mismatched', ledgerTotal, providerTotal, discrepancy],
    );
  }

  async findRun(merchantId: string, runId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query(
      `SELECT r.*,COALESCE(jsonb_agg(i ORDER BY i.id) FILTER(WHERE i.id IS NOT NULL),'[]') items
       FROM payments.reconciliation_runs r LEFT JOIN payments.reconciliation_items i ON i.run_id=r.id
       WHERE r.merchant_id=$1 AND r.id=$2 GROUP BY r.id`,
      [merchantId, runId],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  }
}
