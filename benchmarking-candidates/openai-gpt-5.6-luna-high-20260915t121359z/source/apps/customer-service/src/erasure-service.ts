import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { config } from '../../../packages/config/src/index.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { deleteMailpitMessages } from '../../../packages/notifications/src/mailpit.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { ErasureRepository, type ErasureRequestRow } from './erasure-repository.js';

interface CleanupArtifacts {
  messageIds: string[];
  objectKeys: string[];
  providerCustomerIds: string[];
}

export class ErasureService {
  private readonly redis = new Redis(config().REDIS_URL);

  constructor(private readonly repository = new ErasureRepository()) {}

  async run(request: ErasureRequestRow, workerId: string): Promise<void> {
    try {
      await this.markErasing(request);
      const artifacts = await this.collectArtifacts(request);
      await this.removeExternalArtifacts(request, artifacts);
      await this.anonymizeDatabase(request, artifacts);
      const cacheKeys = await this.customerCacheKeys(request);
      if (cacheKeys.length) await this.redis.del(...cacheKeys);
      await searchClient.delete({ index: CUSTOMER_INDEX, id: `${request.merchant_id}:${request.customer_id}` }, { ignore: [404] });
      await this.repository.markCompleted(request.id, workerId);
    } catch (error) {
      await this.repository.markFailed(request.id, workerId, this.errorCode(error));
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private async markErasing(request: ErasureRequestRow): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO privacy.erased_customers(merchant_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [request.merchant_id, request.customer_id],
      );
      await client.query(
        `UPDATE customers.customers SET status='erasing',updated_at=now()
         WHERE merchant_id=$1 AND id=$2 AND status='active'`,
        [request.merchant_id, request.customer_id],
      );
    });
  }

  private async collectArtifacts(request: ErasureRequestRow): Promise<CleanupArtifacts> {
    const result = await pool.query<{ message_ids: string[]; object_keys: string[] }>(
      `SELECT ARRAY(SELECT DISTINCT provider_message_id FROM operations.email_deliveries
                    WHERE merchant_id=$1 AND customer_id=$2 AND provider_message_id IS NOT NULL) message_ids,
         ARRAY(SELECT object_key FROM operations.document_manifests
               WHERE merchant_id=$1 AND (customer_id=$2 OR metadata->>'customerId'=$2::text)) object_keys
       FROM customers.customers c WHERE c.merchant_id=$1 AND c.id=$2`,
      [request.merchant_id, request.customer_id],
    );
    const row = result.rows[0];
    if (!row) return { messageIds: [], objectKeys: [], providerCustomerIds: [] };
    const providers = await pool.query<{ provider_customer_id: string }>(
      `SELECT provider_customer_id FROM customers.provider_customer_mappings
       WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
    );
    return {
      messageIds: [...new Set(row.message_ids.filter((value) => Boolean(value)))],
      objectKeys: [...new Set(row.object_keys.filter((value) => Boolean(value)))],
      providerCustomerIds: providers.rows.map((provider) => provider.provider_customer_id),
    };
  }

  private async removeExternalArtifacts(_request: ErasureRequestRow, artifacts: CleanupArtifacts): Promise<void> {
    if (artifacts.messageIds.length) await deleteMailpitMessages(artifacts.messageIds);
    for (const objectKey of artifacts.objectKeys) await objectStore.removeObject(DOCUMENT_BUCKET, objectKey);
  }

  private async anonymizeDatabase(request: ErasureRequestRow, artifacts: CleanupArtifacts): Promise<void> {
    await transaction(async (client) => {
      const merchantId = request.merchant_id;
      const customerId = request.customer_id;
      await client.query(
        `INSERT INTO privacy.erased_customers(merchant_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [merchantId, customerId],
      );
      await client.query(
        `UPDATE operations.jobs SET status=CASE WHEN status IN ('pending','retry','processing') THEN 'completed' ELSE status END,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error='customer_erased',
           payload=jsonb_build_object('customerErased',true)
         WHERE merchant_id=$1 AND payload->>'customerId'=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `UPDATE operations.outbox_events SET payload=jsonb_build_object('customerErased',true),
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error='customer_erased'
         WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2)`,
        [merchantId, customerId],
      );
      await client.query(
        `UPDATE operations.provider_webhooks SET status='processed',payload='{"customerErased":true}',
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error='customer_erased'
         WHERE payload->'data'->>'merchantId'=$1 AND
           (payload->'data'->>'customerId'=$2 OR payload->'data'->>'providerCustomerId'=ANY($3::text[]))`,
        [merchantId, customerId, artifacts.providerCustomerIds],
      );
      await client.query(
        `DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM operations.document_manifests
         WHERE merchant_id=$1 AND (customer_id=$2 OR metadata->>'customerId'=$2::text)`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.support_messages WHERE merchant_id=$1 AND author_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.support_participants WHERE customer_id=$1 AND ticket_id IN
           (SELECT ticket_id FROM customers.support_participants WHERE customer_id=$1)`, [customerId],
      );
      await client.query(
        `DELETE FROM customers.support_tickets t WHERE t.merchant_id=$1 AND NOT EXISTS
           (SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id) AND NOT EXISTS
           (SELECT 1 FROM customers.support_messages m WHERE m.ticket_id=t.id)`, [merchantId],
      );
      await client.query(
        `DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `UPDATE provider_sandbox.payment_intents
         SET provider_customer_id=NULL,payment_method_id=NULL,webhook_url='',last_delivery_error='customer_erased'
         WHERE merchant_id=$1 AND provider_customer_id = ANY($3::text[])`,
        [merchantId, customerId, artifacts.providerCustomerIds],
      );
      await client.query(
        `DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `UPDATE payments.refunds r SET customer_email=NULL
         FROM payments.payment_intents p
         WHERE r.payment_intent_id=p.id AND r.merchant_id=$1 AND p.customer_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `UPDATE payments.payment_attempts a SET request_payload='{}'::jsonb,response_payload='{}'::jsonb
         FROM payments.payment_intents p
         WHERE a.payment_intent_id=p.id AND a.merchant_id=$1 AND p.customer_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `UPDATE payments.payment_intents
         SET customer_id=NULL,payment_method_id=NULL,description=NULL,customer_snapshot='{}'::jsonb,updated_at=now()
         WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `UPDATE payments.invoices SET customer_id=NULL,billing_snapshot='{}'::jsonb
         WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM operations.dead_letters
         WHERE payload->>'customerId'=$1 OR payload->'data'->>'customerId'=$1`, [customerId],
      );
      await client.query(
        `DELETE FROM platform.audit_logs WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`,
        [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM operations.inbox_events WHERE event_id IN
           (SELECT id FROM operations.outbox_events WHERE merchant_id=$1 AND aggregate_id=$2)`,
        [merchantId, customerId],
      );
      await client.query(
        `DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId],
      );
    });
  }

  private async customerCacheKeys(request: ErasureRequestRow): Promise<string[]> {
    const pattern = `merchant:${request.merchant_id}:customer:${request.customer_id}*`;
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, found] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      keys.push(...found);
    } while (cursor !== '0');
    return keys;
  }

  private errorCode(error: unknown): string {
    if (error instanceof Error && error.message.startsWith('mailpit_')) return 'email_cleanup_failed';
    if (error instanceof Error && error.message.startsWith('minio_')) return 'storage_cleanup_failed';
    if (error instanceof Error && error.message.includes('opensearch')) return 'search_cleanup_failed';
    return 'database_cleanup_failed';
  }
}

export function newErasureWorkerId(): string {
  return `erasure-worker-${randomUUID()}`;
}
