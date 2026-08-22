import { advisoryLock, transaction } from '../../../../packages/database/src/pool.js';
import { erasedCustomerBlock, redactSubjectValue, sanitizeSubjectPayload } from '../../../../packages/privacy/src/redact.js';
import type { ErasureRequestRecord, SubjectContext } from '../../../../packages/privacy/src/types.js';

type PaymentRow = { id: string; description: string | null; customer_snapshot: Record<string, unknown> };
type JsonRow = { id: string; request_payload?: unknown; response_payload?: unknown; evidence?: unknown };

/** Retains financial facts while removing direct customer identity and free-form PII. */
export async function anonymizeFinancialRecords(request: ErasureRequestRecord): Promise<void> {
  const context = request.subject_context as SubjectContext;
  await transaction(async (client) => {
    await advisoryLock(client, `privacy:${request.merchant_id}:${request.customer_id}`);
    const payments = await client.query<PaymentRow>(
      `SELECT id,description,customer_snapshot FROM payments.payment_intents
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`, [request.merchant_id, request.customer_id],
    );
    const paymentIds = payments.rows.map((row) => row.id);
    for (const payment of payments.rows) {
      await client.query(
        `UPDATE payments.payment_intents
         SET customer_id=$2,payment_method_id=$2,description=$3,customer_snapshot=$4,updated_at=now()
         WHERE id=$1`,
        [payment.id, request.surrogate_id,
          payment.description ? redactSubjectValue(payment.description, context) : null,
          erasedCustomerBlock(context)],
      );
    }

    if (paymentIds.length) {
      const attempts = await client.query<JsonRow>(
        `SELECT id,request_payload,response_payload FROM payments.payment_attempts
         WHERE payment_intent_id=ANY($1::uuid[]) FOR UPDATE`, [paymentIds],
      );
      for (const attempt of attempts.rows) {
        await client.query(
          `UPDATE payments.payment_attempts SET request_payload=$2,response_payload=$3 WHERE id=$1`,
          [attempt.id, sanitizeSubjectPayload(attempt.request_payload, context),
            sanitizeSubjectPayload(attempt.response_payload ?? null, context)],
        );
      }

      const refunds = await client.query<{ id: string; reason: string }>(
        `SELECT id,reason FROM payments.refunds WHERE payment_intent_id=ANY($1::uuid[]) FOR UPDATE`, [paymentIds],
      );
      for (const refund of refunds.rows) {
        await client.query(`UPDATE payments.refunds SET customer_email=NULL,reason=$2 WHERE id=$1`,
          [refund.id, redactSubjectValue(refund.reason, context)]);
      }

      const disputes = await client.query<JsonRow>(
        `SELECT id,evidence FROM payments.disputes WHERE payment_intent_id=ANY($1::uuid[]) FOR UPDATE`, [paymentIds],
      );
      for (const dispute of disputes.rows) {
        await client.query(`UPDATE payments.disputes SET evidence=$2 WHERE id=$1`,
          [dispute.id, sanitizeSubjectPayload(dispute.evidence, context)]);
      }
    }

    const invoices = await client.query<{ id: string }>(
      `UPDATE payments.invoices SET customer_id=$3,billing_snapshot=$4
       WHERE merchant_id=$1 AND customer_id=$2 RETURNING id`,
      [request.merchant_id, request.customer_id, request.surrogate_id, erasedCustomerBlock(context)],
    );
    for (const invoice of invoices.rows) {
      const lines = await client.query<{ id: string; description: string }>(
        `SELECT id,description FROM payments.invoice_lines WHERE invoice_id=$1 FOR UPDATE`, [invoice.id],
      );
      for (const line of lines.rows) {
        await client.query(`UPDATE payments.invoice_lines SET description=$2 WHERE id=$1`,
          [line.id, redactSubjectValue(line.description, context)]);
      }
    }
  });
}
