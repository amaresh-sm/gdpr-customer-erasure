import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { ReconciliationRepository, type ProviderTransaction } from './reconciliation-repository.js';

export class ReconciliationService {
  constructor(private readonly repository = new ReconciliationRepository()) {}

  async importSettlement(merchantId: string): Promise<{ settlementId: string; imported: number }> {
    const response = await fetch(`${config().PROCESSOR_URL}/v1/settlements`);
    if (!response.ok) throw Object.assign(new Error('provider unavailable'), { statusCode: 503 });
    const feed = await response.json() as { generatedAt: string; transactions: ProviderTransaction[] };
    const transactions = feed.transactions.filter((item) => item.merchantId === merchantId);
    const settlementId = `set_${uuid()}`;
    const gross = transactions.reduce((sum, item) => sum + item.amount, 0);
    await transaction(async (client) => {
      await this.repository.storeSettlement(
        client, merchantId, settlementId, gross, transactions[0]?.currency ?? 'USD', feed,
      );
      await addOutboxEvent(client, {
        eventType: EVENT_TYPES.SETTLEMENT_IMPORTED, aggregateType: 'merchant', aggregateId: merchantId,
        merchantId, correlationId: uuid(), payload: { settlementId, transactionCount: transactions.length, gross }
      });
    });
    return { settlementId, imported: transactions.length };
  }

  async reconcile(merchantId: string): Promise<Record<string, unknown>> {
    const runId = uuid();
    return await transaction(async (client) => {
      await this.repository.startRun(client, runId, merchantId);
      const ledger = await this.repository.listPayments(client, merchantId);
      const provider = new Map(
        (await this.repository.latestSettlement(client, merchantId))
          .map((item) => [item.providerPaymentId, item.amount]),
      );
      let ledgerTotal = 0;
      let providerTotal = 0;
      for (const payment of ledger) {
        const ledgerAmount = Number(payment.amount);
        const providerAmount = provider.get(payment.provider_payment_id) ?? null;
        ledgerTotal += ledgerAmount;
        providerTotal += providerAmount ?? 0;
        await this.repository.addItem(client, runId, payment, providerAmount);
      }
      const discrepancy = providerTotal - ledgerTotal;
      await this.repository.completeRun(client, runId, ledgerTotal, providerTotal);
      await addOutboxEvent(client, {
        eventType: EVENT_TYPES.RECONCILIATION_COMPLETED, aggregateType: 'merchant', aggregateId: merchantId,
        merchantId, correlationId: uuid(), payload: { runId, ledgerTotal, providerTotal, discrepancy }
      });
      return { id: runId, status: discrepancy === 0 ? 'matched' : 'mismatched', ledgerTotal, providerTotal, discrepancy };
    });
  }

  async getRun(merchantId: string, runId: string): Promise<Record<string, unknown> | undefined> {
    return await this.repository.findRun(merchantId, runId);
  }
}
