import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';

type ProviderTransaction = { providerPaymentId: string; paymentId: string; merchantId: string; amount: number; currency: string };

export class ReconciliationService {
  async importSettlement(merchantId: string): Promise<{ settlementId: string; imported: number }> {
    const response = await fetch(`${config().PROCESSOR_URL}/v1/settlements`);
    if (!response.ok) throw Object.assign(new Error('provider unavailable'), { statusCode: 503 });
    const feed = await response.json() as { generatedAt: string; transactions: ProviderTransaction[] };
    const transactions = feed.transactions.filter((item) => item.merchantId === merchantId);
    const settlementId = `set_${uuid()}`;
    const gross = transactions.reduce((sum, item) => sum + item.amount, 0);
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO payments.provider_settlements
         (merchant_id,provider_settlement_id,period_start,period_end,gross,fees,net,currency,raw_payload)
         VALUES($1,$2,now()-interval '1 day',now(),$3,0,$3,$4,$5)`,
        [merchantId, settlementId, gross, transactions[0]?.currency ?? 'USD', feed],
      );
      await addOutboxEvent(client, { eventType: EVENT_TYPES.SETTLEMENT_IMPORTED, aggregateType: 'merchant', aggregateId: merchantId,
        merchantId, correlationId: uuid(), payload: { settlementId, transactionCount: transactions.length, gross } });
    });
    return { settlementId, imported: transactions.length };
  }

  async reconcile(merchantId: string): Promise<Record<string, unknown>> {
    const runId = uuid();
    return await transaction(async (client) => {
      await client.query(`INSERT INTO payments.reconciliation_runs(id,merchant_id,status) VALUES($1,$2,'running')`, [runId, merchantId]);
      const ledger = await client.query<{ id: string; provider_payment_id: string; amount: string }>(
        `SELECT p.id,p.provider_payment_id,p.amount::text FROM payments.payment_intents p
         WHERE p.merchant_id=$1 AND p.status IN ('succeeded','partially_refunded','refunded')`, [merchantId],
      );
      const settlement = await client.query<{ raw_payload: { transactions: ProviderTransaction[] } }>(
        `SELECT raw_payload FROM payments.provider_settlements WHERE merchant_id=$1 ORDER BY imported_at DESC LIMIT 1`, [merchantId],
      );
      const provider = new Map((settlement.rows[0]?.raw_payload.transactions ?? []).map((item) => [item.providerPaymentId, item.amount]));
      let ledgerTotal = 0;
      let providerTotal = 0;
      for (const payment of ledger.rows) {
        const ledgerAmount = Number(payment.amount);
        const providerAmount = provider.get(payment.provider_payment_id) ?? null;
        ledgerTotal += ledgerAmount;
        providerTotal += providerAmount ?? 0;
        await client.query(
          `INSERT INTO payments.reconciliation_items(run_id,reference_type,reference_id,ledger_amount,provider_amount,status,detail)
           VALUES($1,'payment',$2,$3,$4,$5,$6)`, [runId, payment.id, ledgerAmount, providerAmount,
            providerAmount === ledgerAmount ? 'matched' : 'mismatched', { providerPaymentId: payment.provider_payment_id }],
        );
      }
      const discrepancy = providerTotal - ledgerTotal;
      await client.query(
        `UPDATE payments.reconciliation_runs SET status=$2,ledger_total=$3,provider_total=$4,discrepancy=$5,completed_at=now() WHERE id=$1`,
        [runId, discrepancy === 0 ? 'matched' : 'mismatched', ledgerTotal, providerTotal, discrepancy],
      );
      await addOutboxEvent(client, { eventType: EVENT_TYPES.RECONCILIATION_COMPLETED, aggregateType: 'merchant', aggregateId: merchantId,
        merchantId, correlationId: uuid(), payload: { runId, ledgerTotal, providerTotal, discrepancy } });
      return { id: runId, status: discrepancy === 0 ? 'matched' : 'mismatched', ledgerTotal, providerTotal, discrepancy };
    });
  }

  async getRun(merchantId: string, runId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query(
      `SELECT r.*,COALESCE(jsonb_agg(i ORDER BY i.id) FILTER(WHERE i.id IS NOT NULL),'[]') items
       FROM payments.reconciliation_runs r LEFT JOIN payments.reconciliation_items i ON i.run_id=r.id
       WHERE r.merchant_id=$1 AND r.id=$2 GROUP BY r.id`, [merchantId, runId],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  }
}
