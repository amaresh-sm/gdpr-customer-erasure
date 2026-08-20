import { transaction } from '../../../../packages/database/src/pool.js';
import type { ErasureRequestRecord } from '../../../../packages/privacy/src/types.js';

/** Deliberately incorrect mutation: deletes legally retained financial facts. */
export async function anonymizeFinancialRecords(request: ErasureRequestRecord): Promise<void> {
  await transaction(async (client) => {
    const payments = await client.query<{ id: string }>(
      `SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [request.merchant_id, request.customer_id],
    );
    const ids = payments.rows.map((row) => row.id);
    await client.query(
      `DELETE FROM payments.invoice_lines WHERE invoice_id IN
       (SELECT id FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2)`,
      [request.merchant_id, request.customer_id],
    );
    await client.query(`DELETE FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2`,
      [request.merchant_id, request.customer_id]);
    if (ids.length) {
      await client.query(`DELETE FROM payments.payment_attempts WHERE payment_intent_id=ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM payments.captures WHERE payment_intent_id=ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM payments.refunds WHERE payment_intent_id=ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM payments.disputes WHERE payment_intent_id=ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM payments.payment_intents WHERE id=ANY($1::uuid[])`, [ids]);
    }
  });
}
