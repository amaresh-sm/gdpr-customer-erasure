import { randomUUID } from 'node:crypto';
import { transaction } from '../../../packages/database/src/pool.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureRepository } from './erasure-repository.js';

const repository = new ErasureRepository();

/** Removes personal data while leaving payment amounts, statuses, and accounting references intact. */
export async function eraseCustomer(request: { id: string; merchant_id: string; customer_id: string }): Promise<void> {
  await transaction(async (client) => {
    const customer = await client.query(
      `SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [request.merchant_id, request.customer_id],
    );
    if (!customer.rowCount) throw new Error('customer_not_found');

    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM customers.support_messages WHERE merchant_id=$1 AND author_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [request.customer_id]);

    await client.query(
      `UPDATE customers.customers SET email='deleted+' || id || '@invalid',name='Deleted customer',phone=NULL,
       external_reference='deleted-' || id,metadata='{}'::jsonb,status='erased',version=version+1,updated_at=now()
       WHERE merchant_id=$1 AND id=$2`, [request.merchant_id, request.customer_id],
    );

    await client.query(
      `UPDATE payments.payment_intents SET customer_snapshot=jsonb_build_object('deleted',true),description=NULL,updated_at=now()
       WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
    );
    await client.query(
      `UPDATE payments.invoices SET billing_snapshot=jsonb_build_object('deleted',true),object_key=NULL
       WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
    );
    await client.query(`UPDATE payments.refunds SET customer_email=NULL WHERE merchant_id=$1 AND payment_intent_id IN
      (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [request.merchant_id, request.customer_id]);

    await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`UPDATE operations.analytics_events SET email=NULL,properties='{"deleted":true}'::jsonb,anonymous_id='erased-' || $2
      WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`UPDATE operations.notification_preferences SET destination='deleted@invalid' WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`UPDATE operations.notifications SET destination='deleted@invalid',payload='{"deleted":true}'::jsonb WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`UPDATE operations.email_deliveries SET destination='deleted@invalid',subject='Deleted',text_body='',html_body='' WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`UPDATE operations.document_manifests SET customer_id=NULL,metadata='{"deleted":true}'::jsonb
      WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]);

    await client.query(`UPDATE operations.audit_logs SET metadata='{"deleted":true}'::jsonb
      WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`UPDATE operations.outbox_events SET payload=jsonb_build_object('customerId',$2,'deleted',true)
      WHERE merchant_id=$1 AND (payload->>'customerId')=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM operations.jobs WHERE merchant_id=$1 AND payload->>'customerId'=$2`, [request.merchant_id, request.customer_id]);
    await client.query(`UPDATE operations.provider_webhooks SET payload=jsonb_build_object('deleted',true)
      WHERE payload::text LIKE '%' || $1 || '%'`, [request.customer_id]);
    await client.query(`UPDATE operations.dead_letters SET payload=jsonb_build_object('deleted',true)
      WHERE payload::text LIKE '%' || $1 || '%'`, [request.customer_id]);

    await repository.complete(client, request.id);
  });
}

export async function runErasureWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const request = await repository.claim();
    if (!request) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try { await eraseCustomer(request); }
    catch (error) {
      logger.error({ error, requestId: request.id }, 'customer erasure failed');
      await repository.fail(request.id, 'cleanup_failed');
    }
  }
}

export function startErasureWorker(signal: AbortSignal): void {
  void runErasureWorker(signal).catch((error) => logger.error({ error, workerId: randomUUID() }, 'erasure worker stopped'));
}
