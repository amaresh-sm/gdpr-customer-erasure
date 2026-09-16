import type pg from 'pg';
import { redactCustomerPayload } from '../../../packages/operations/src/pii-redaction.js';

export interface DocumentToRedact {
  object_key: string;
  document_type: string;
}

const ERASED_EMAIL = 'erased-customer@erased.invalid';
const ERASED_NAME = 'Erased Customer';

function tombstoneEmail(customerId: string): string {
  return `erased-${customerId}@erased.invalid`;
}

function tombstoneReference(customerId: string): string {
  return `erased-${customerId}`;
}

/**
 * Scrubs every PayFlow-controlled row that identifies this customer, across
 * the customers, payments, and operations schemas that share this database.
 * Every statement is safe to re-run: deletes are naturally idempotent and
 * updates write the same deterministic tombstone values on every attempt, so
 * a retried or resumed erasure converges on the same result.
 */
export class ErasureScrubRepository {
  async scrub(client: pg.PoolClient, merchantId: string, customerId: string): Promise<DocumentToRedact[]> {
    await this.redactPaymentSnapshots(client, merchantId, customerId);
    await this.redactRefundEmails(client, merchantId, customerId);
    await this.redactInvoiceSnapshots(client, merchantId, customerId);
    await this.redactAnalyticsEvents(client, merchantId, customerId);
    await this.redactPendingJobs(client, merchantId, customerId);
    await this.redactPendingOutboxEvents(client, merchantId, customerId);
    await this.deleteNotificationRecords(client, merchantId, customerId);
    await this.deleteOwnedProfileData(client, customerId);
    await this.deleteSupportData(client, merchantId, customerId);
    await this.deleteProviderLinks(client, merchantId, customerId);
    const manifests = await this.documentManifests(client, merchantId, customerId);
    await this.tombstoneCustomer(client, merchantId, customerId);
    return manifests;
  }

  private async redactPaymentSnapshots(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const rows = await client.query<{ id: string; customer_snapshot: Record<string, unknown> }>(
      `SELECT id,customer_snapshot FROM payments.payment_intents
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    for (const row of rows.rows) {
      await client.query(
        `UPDATE payments.payment_intents SET customer_snapshot=$3 WHERE id=$1 AND merchant_id=$2`,
        [row.id, merchantId, redactCustomerPayload(row.customer_snapshot)],
      );
    }
  }

  private async redactRefundEmails(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(
      `UPDATE payments.refunds SET customer_email=$3
       WHERE merchant_id=$2 AND customer_email IS NOT NULL AND customer_email<>$3
         AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$2 AND customer_id=$1)`,
      [customerId, merchantId, ERASED_EMAIL],
    );
  }

  private async redactInvoiceSnapshots(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const rows = await client.query<{ id: string; billing_snapshot: Record<string, unknown> }>(
      `SELECT id,billing_snapshot FROM payments.invoices
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    for (const row of rows.rows) {
      await client.query(
        `UPDATE payments.invoices SET billing_snapshot=$3 WHERE id=$1 AND merchant_id=$2`,
        [row.id, merchantId, redactCustomerPayload(row.billing_snapshot)],
      );
    }
  }

  private async redactAnalyticsEvents(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const rows = await client.query<{ id: string; properties: Record<string, unknown> }>(
      `SELECT id,properties FROM operations.analytics_events
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    for (const row of rows.rows) {
      await client.query(
        `UPDATE operations.analytics_events SET email=NULL,properties=$3 WHERE id=$1 AND merchant_id=$2`,
        [row.id, merchantId, redactCustomerPayload(row.properties)],
      );
    }
  }

  private async redactPendingJobs(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const rows = await client.query<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id,payload FROM operations.jobs
       WHERE merchant_id=$1 AND status NOT IN ('completed','dead') AND payload->>'customerId'=$2
       FOR UPDATE`,
      [merchantId, customerId],
    );
    for (const row of rows.rows) {
      await client.query(`UPDATE operations.jobs SET payload=$3 WHERE id=$1 AND merchant_id=$2`,
        [row.id, merchantId, redactCustomerPayload(row.payload)]);
    }
  }

  private async redactPendingOutboxEvents(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const rows = await client.query<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id,payload FROM operations.outbox_events
       WHERE merchant_id=$1 AND status<>'published'
         AND (payload->>'customerId'=$2 OR aggregate_id=$2::uuid)
       FOR UPDATE`,
      [merchantId, customerId],
    );
    for (const row of rows.rows) {
      await client.query(`UPDATE operations.outbox_events SET payload=$3 WHERE id=$1 AND merchant_id=$2`,
        [row.id, merchantId, redactCustomerPayload(row.payload)]);
    }
  }

  private async deleteNotificationRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  }

  private async deleteOwnedProfileData(client: pg.PoolClient, customerId: string): Promise<void> {
    await client.query(`DELETE FROM customers.addresses WHERE customer_id=$1`, [customerId]);
    await client.query(`DELETE FROM customers.contacts WHERE customer_id=$1`, [customerId]);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE customer_id=$1`, [customerId]);
  }

  private async deleteSupportData(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(
      `DELETE FROM customers.support_messages
       WHERE author_type='customer' AND author_id=$1
         AND ticket_id IN (SELECT ticket_id FROM customers.support_participants WHERE customer_id=$1)`,
      [customerId],
    );
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);
    await client.query(
      `DELETE FROM customers.support_tickets t
       WHERE merchant_id=$1
         AND NOT EXISTS(SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id)
         AND NOT EXISTS(SELECT 1 FROM customers.support_messages m WHERE m.ticket_id=t.id)`,
      [merchantId],
    );
  }

  private async deleteProviderLinks(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, [merchantId, customerId]);
  }

  private async documentManifests(client: pg.PoolClient, merchantId: string, customerId: string): Promise<DocumentToRedact[]> {
    const result = await client.query<DocumentToRedact>(
      `SELECT object_key,document_type FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    return result.rows;
  }

  private async tombstoneCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(
      `UPDATE customers.customers
       SET email=$3,name=$4,phone=NULL,external_reference=$5,metadata='{}',status='erased',
           erased_at=COALESCE(erased_at,now()),version=version+1,updated_at=now()
       WHERE id=$1 AND merchant_id=$2 AND status<>'erased'`,
      [customerId, merchantId, tombstoneEmail(customerId), ERASED_NAME, tombstoneReference(customerId)],
    );
  }
}
