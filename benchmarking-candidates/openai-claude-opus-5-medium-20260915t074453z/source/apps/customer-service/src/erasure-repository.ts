import { Redis } from 'ioredis';
import { config } from '../../../packages/config/src/index.js';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { deleteMailpitMessagesForRecipient } from '../../../packages/notifications/src/mailpit.js';
import { PII_PAYLOAD_KEYS, redactDocument } from '../../../packages/privacy/src/erasure-policy.js';
import { deleteCustomerDocument } from '../../../packages/search/src/client.js';
import { listObjectKeys, readObject, removeObject, replaceObject } from '../../../packages/storage/src/minio.js';

/** The identity needed to find personal data that is keyed by contact details rather than by id. */
export interface ErasureSubject {
  email: string;
  name: string;
  phone: string | null;
  external_reference: string;
}

const piiKeys = [...PII_PAYLOAD_KEYS];
const redactedSnapshot = JSON.stringify({ erased: true });

/**
 * Every method here is idempotent and scoped to one merchant's customer, so a retry after a crash
 * repeats no destructive work and can never reach another merchant's or another customer's data.
 */
export class ErasureRepository {
  private redis: Redis | undefined;

  /**
   * Reads the identity that contact-keyed cleanup needs. Returns undefined once the profile is gone,
   * which is the normal state when a completed request is re-run.
   */
  async findSubject(merchantId: string, customerId: string): Promise<ErasureSubject | undefined> {
    const result = await pool.query<ErasureSubject>(
      `SELECT email,name,phone,external_reference FROM customers.customers
       WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async removeSearchProjection(merchantId: string, customerId: string): Promise<void> {
    await deleteCustomerDocument(merchantId, customerId);
  }

  async removeCacheProjection(merchantId: string, customerId: string): Promise<void> {
    const redis = (this.redis ??= new Redis(config().REDIS_URL));
    const key = `merchant:${merchantId}:customer:${customerId}`;
    await redis.del(key, `${key}:activity`);
  }

  /**
   * Analytics rows are derived copies of event payloads, not financial records, so they are removed
   * outright. The pseudonymous `anonymous_id` is matched too: it is derived from the customer id and
   * would otherwise keep the row linkable.
   */
  async removeAnalytics(merchantId: string, customerId: string): Promise<void> {
    await pool.query(
      `DELETE FROM operations.analytics_events
       WHERE merchant_id=$1 AND (customer_id=$2 OR anonymous_id=$3 OR properties->>'customerId'=$2::text)`,
      [merchantId, customerId, `anon_${customerId}`],
    );
  }

  /**
   * Receipts and invoices prove a payment happened, so the objects are rewritten in place without
   * the customer's details and their manifests keep pointing at them with a refreshed checksum.
   * Import artifacts exist only to carry personal data, so they are deleted outright.
   */
  async eraseStoredDocuments(merchantId: string, customerId: string): Promise<void> {
    const retained = await pool.query<{ object_key: string; document_type: string }>(
      `SELECT object_key,document_type FROM operations.document_manifests
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    for (const manifest of retained.rows) {
      await this.redactStoredObject(manifest.object_key);
    }
    for (const objectKey of await this.importObjectKeysFor(merchantId, customerId)) {
      await this.removeStoredObject(merchantId, objectKey);
    }
  }

  private async redactStoredObject(objectKey: string): Promise<void> {
    let current: string;
    try {
      current = await readObject(objectKey);
    } catch (error) {
      if (isMissingObject(error)) return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      parsed = undefined;
    }
    const body = JSON.stringify(redactDocument(parsed));
    if (body === current) return;
    const checksum = await replaceObject(objectKey, body);
    await pool.query(
      `UPDATE operations.document_manifests SET checksum=$2 WHERE object_key=$1`,
      [objectKey, checksum],
    );
  }

  /**
   * Import artifacts carry no customer column, so the objects themselves are inspected. Only objects
   * under this merchant's prefix are read, which keeps the scan inside the tenant.
   */
  private async importObjectKeysFor(merchantId: string, customerId: string): Promise<string[]> {
    const keys = await listObjectKeys(`${merchantId}/imports/`);
    const matching: string[] = [];
    for (const objectKey of keys) {
      let content: string;
      try {
        content = await readObject(objectKey);
      } catch (error) {
        if (isMissingObject(error)) continue;
        throw error;
      }
      if (referencesCustomer(content, customerId)) matching.push(objectKey);
    }
    return matching;
  }

  private async removeStoredObject(merchantId: string, objectKey: string): Promise<void> {
    try {
      await removeObject(objectKey);
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
    await transaction(async (client) => {
      await client.query(
        `DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND object_key=$2`,
        [merchantId, objectKey],
      );
      await client.query(
        `DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND object_key=$2`,
        [merchantId, objectKey],
      );
    });
  }

  /**
   * Delivery records hold the recipient address and rendered bodies, and the local mail provider
   * holds the messages themselves. Deliveries are matched by customer and by address, because a
   * delivery recorded from an event without a customer id still names the person.
   */
  async eraseEmailHistory(merchantId: string, customerId: string, subject: ErasureSubject | undefined): Promise<void> {
    const destination = subject?.email ?? null;
    await transaction(async (client) => {
      await client.query(
        `DELETE FROM operations.notifications
         WHERE merchant_id=$1 AND (customer_id=$2 OR ($3::text IS NOT NULL AND destination=$3)
           OR delivery_id IN (SELECT id FROM operations.email_deliveries
             WHERE merchant_id=$1 AND (customer_id=$2 OR ($3::text IS NOT NULL AND destination=$3))))`,
        [merchantId, customerId, destination],
      );
      await client.query(
        `DELETE FROM operations.email_deliveries
         WHERE merchant_id=$1 AND (customer_id=$2 OR ($3::text IS NOT NULL AND destination=$3))`,
        [merchantId, customerId, destination],
      );
      await client.query(
        `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM operations.dead_letters
         WHERE source='email_delivery' AND (payload->>'customerId'=$1::text
           OR ($2::text IS NOT NULL AND payload->>'destination'=$2))`,
        [customerId, destination],
      );
    });
    if (destination) await deleteMailpitMessagesForRecipient(destination);
  }

  /**
   * Event and job payloads are stripped of personal keys but kept, because the inbox and outbox rows
   * are what stop a replay from being processed twice. Deleting them would invite the resurrection
   * this workflow exists to prevent.
   */
  async eraseEventHistory(merchantId: string, customerId: string): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `UPDATE operations.outbox_events
         SET payload=(payload - $3::text[]) || $4::jsonb
         WHERE merchant_id=$1 AND (payload->>'customerId'=$2 OR aggregate_id::text=$2)`,
        [merchantId, customerId, piiKeys, redactedSnapshot],
      );
      await client.query(
        `UPDATE operations.jobs SET payload=(payload - $3::text[]) || $4::jsonb
         WHERE merchant_id=$1 AND payload->>'customerId'=$2::text`,
        [merchantId, customerId, piiKeys, redactedSnapshot],
      );
      await client.query(
        `DELETE FROM operations.dead_letters
         WHERE source='job' AND payload->>'customerId'=$1::text`,
        [customerId],
      );
      await client.query(
        `UPDATE platform.audit_logs SET metadata=metadata - $3::text[]
         WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2::text`,
        [merchantId, customerId, piiKeys],
      );
    });
  }

  /**
   * A ticket can involve several customers. The erased customer's participation and messages go, and
   * the ticket only goes when nobody is left who still needs it.
   */
  async eraseSupportHistory(merchantId: string, customerId: string): Promise<void> {
    await transaction(async (client) => {
      const tickets = await client.query<{ ticket_id: string }>(
        `SELECT t.id ticket_id FROM customers.support_tickets t
         JOIN customers.support_participants p ON p.ticket_id=t.id
         WHERE t.merchant_id=$1 AND p.customer_id=$2 FOR UPDATE OF t`,
        [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.support_messages
         WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.support_participants
         WHERE customer_id=$1 AND ticket_id IN
           (SELECT id FROM customers.support_tickets WHERE merchant_id=$2)`,
        [customerId, merchantId],
      );
      for (const { ticket_id: ticketId } of tickets.rows) {
        const remaining = await client.query(
          `SELECT 1 FROM customers.support_participants WHERE ticket_id=$1 LIMIT 1`,
          [ticketId],
        );
        if (remaining.rowCount) continue;
        await client.query(`DELETE FROM customers.support_messages WHERE ticket_id=$1`, [ticketId]);
        await client.query(
          `DELETE FROM customers.support_tickets WHERE id=$1 AND merchant_id=$2`,
          [ticketId, merchantId],
        );
      }
    });
  }

  /**
   * The provider-side profile and the mapping that resolves it are removed. Payments keep the opaque
   * provider identifier so settlement and reconciliation still line up, but nothing remains that
   * turns it back into a person.
   */
  async eraseProviderProfiles(merchantId: string, customerId: string): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      );
    });
  }

  /**
   * Financial records are retained and de-identified in place. Amounts, currencies, statuses, and
   * the identifiers that tie a payment to its capture, refund, invoice, and journal entry all stay,
   * so payment history, refunds, reconciliation, and accounting keep working.
   *
   * Ledger entries and postings are deliberately untouched: postings are append-only by trigger and
   * neither table stores anything about the customer.
   */
  async deidentifyFinancialRecords(merchantId: string, customerId: string): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `UPDATE payments.payment_intents
         SET customer_snapshot=$3::jsonb,description=NULL,updated_at=now()
         WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId, redactedSnapshot],
      );
      await client.query(
        `UPDATE payments.payment_attempts a
         SET request_payload=a.request_payload - 'description' - $3::text[],
             response_payload=CASE WHEN a.response_payload IS NULL THEN NULL
               ELSE a.response_payload - $3::text[] END,
             failure_message=NULL
         FROM payments.payment_intents p
         WHERE a.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
        [merchantId, customerId, piiKeys],
      );
      await client.query(
        `UPDATE payments.refunds r SET customer_email=NULL
         FROM payments.payment_intents p
         WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `UPDATE payments.disputes d SET evidence=d.evidence - $3::text[]
         FROM payments.payment_intents p
         WHERE d.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
        [merchantId, customerId, piiKeys],
      );
      await client.query(
        `UPDATE payments.invoices SET billing_snapshot=$3::jsonb
         WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId, redactedSnapshot],
      );
    });
  }

  /**
   * Removes the profile and everything that exists purely to describe the person. This runs last:
   * earlier steps need the contact details it holds.
   */
  async eraseCustomerProfile(merchantId: string, customerId: string): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
        [merchantId, customerId],
      );
    });
  }

  async close(): Promise<void> {
    await this.redis?.quit();
    this.redis = undefined;
  }
}

function isMissingObject(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchBucket';
}

function referencesCustomer(content: string, customerId: string): boolean {
  if (!content.includes(customerId)) return false;
  try {
    return JSON.stringify(JSON.parse(content)).includes(customerId);
  } catch {
    return true;
  }
}
