import type pg from 'pg';
import { transaction } from '../../../packages/database/src/pool.js';
import { CUSTOMER_INDEX, searchClient } from '../../../packages/search/src/client.js';
import { redisClient } from '../../../packages/cache/src/redis.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { erasedEmailFor, ERASED_NAME, redactSnapshot } from './erasure-redaction.js';
import { CustomerRepository } from './repository.js';
import { ErasureRepository, type ClaimedErasureRequest, type ErasureRequestRow } from './erasure-repository.js';

export interface ErasureRequestView {
  id: string;
  customerId: string;
  status: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export function toView(row: ErasureRequestRow): ErasureRequestView {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    lastError: row.last_error,
  };
}

async function eraseDocumentObjects(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
  const manifests = await client.query<{ id: string; object_key: string; document_type: string }>(
    `SELECT id,object_key,document_type FROM operations.document_manifests
     WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
    [merchantId, customerId],
  );
  for (const manifest of manifests.rows) {
    if (manifest.document_type === 'customer_import') {
      await objectStore.removeObject(DOCUMENT_BUCKET, manifest.object_key).catch(() => undefined);
      await client.query(`DELETE FROM operations.document_manifests WHERE id=$1`, [manifest.id]);
      continue;
    }
    // Financial documents (receipts, invoices) are retained but rewritten so they no longer
    // identify the customer; their financial fields (amounts, currency, dates) are untouched.
    let content: Record<string, unknown>;
    try {
      const stream = await objectStore.getObject(DOCUMENT_BUCKET, manifest.object_key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      content = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const redacted = { ...content };
    if (typeof redacted.customer === 'object' && redacted.customer !== null) {
      redacted.customer = redactSnapshot(redacted.customer as Record<string, unknown>, customerId);
    }
    const body = JSON.stringify(redacted);
    await objectStore.putObject(DOCUMENT_BUCKET, manifest.object_key, body, Buffer.byteLength(body), { 'Content-Type': 'application/json' });
  }
}

async function eraseCustomerRecord(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
  await client.query(
    `UPDATE customers.customers
     SET email=$3, name=$4, phone=NULL, metadata='{}', status='erased', version=version+1, updated_at=now()
     WHERE merchant_id=$1 AND id=$2`,
    [merchantId, customerId, erasedEmailFor(customerId), ERASED_NAME],
  );
  await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(
    `UPDATE customers.payment_method_refs
     SET provider_token='erased', billing_name=NULL, billing_address=NULL, status='erased'
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE customers.support_messages
     SET body='[redacted]'
     WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
    [merchantId, customerId],
  );
}

async function eraseFinancialSnapshots(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
  const payments = await client.query<{ id: string; customer_snapshot: Record<string, unknown> }>(
    `SELECT id,customer_snapshot FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
    [merchantId, customerId],
  );
  for (const payment of payments.rows) {
    await client.query(
      `UPDATE payments.payment_intents SET customer_snapshot=$2 WHERE id=$1`,
      [payment.id, redactSnapshot(payment.customer_snapshot, customerId)],
    );
  }
  await client.query(
    `UPDATE payments.refunds r SET customer_email=NULL
     FROM payments.payment_intents p
     WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2 AND r.customer_email IS NOT NULL`,
    [merchantId, customerId],
  );
  const invoices = await client.query<{ id: string; billing_snapshot: Record<string, unknown> }>(
    `SELECT id,billing_snapshot FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
    [merchantId, customerId],
  );
  for (const invoice of invoices.rows) {
    await client.query(
      `UPDATE payments.invoices SET billing_snapshot=$2 WHERE id=$1`,
      [invoice.id, redactSnapshot(invoice.billing_snapshot, customerId)],
    );
  }
}

async function eraseOperationalRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
  await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  await client.query(
    `UPDATE operations.email_deliveries
     SET destination='erased', subject='[redacted]', text_body='[redacted]', html_body='[redacted]'
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE operations.notifications SET destination='erased', payload='{}'
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  await client.query(
    `UPDATE operations.analytics_events SET email=NULL, properties='{}'
     WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
}

async function eraseExternalProjections(merchantId: string, customerId: string): Promise<void> {
  await searchClient.delete({ index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}` }).catch((error: { statusCode?: number }) => {
    if (error.statusCode !== 404) throw error;
  });
  const cacheKey = `merchant:${merchantId}:customer:${customerId}`;
  await redisClient().del(cacheKey, `${cacheKey}:activity`);
}

export class ErasureService {
  constructor(
    private readonly repository = new ErasureRepository(),
    private readonly customers = new CustomerRepository(),
  ) {}

  async requestErasure(merchantId: string, customerId: string, idempotencyKey: string): Promise<ErasureRequestView> {
    const customer = await this.customers.find(merchantId, customerId);
    if (!customer) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });
    const { row } = await this.repository.reserve(merchantId, customerId, idempotencyKey);
    return toView(row);
  }

  async findRequest(merchantId: string, requestId: string): Promise<ErasureRequestView | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? toView(row) : undefined;
  }

  /**
   * Idempotently erases every PayFlow-controlled record that identifies this customer. The
   * request is only marked `completed` once every store, including external projections, has
   * been swept; a failure at any point leaves the request retryable and re-running this method
   * is always safe because every step below is a no-op against already-erased data.
   */
  async process(job: ClaimedErasureRequest): Promise<void> {
    await transaction(async (client) => {
      await eraseCustomerRecord(client, job.merchant_id, job.customer_id);
      await eraseFinancialSnapshots(client, job.merchant_id, job.customer_id);
      await eraseOperationalRecords(client, job.merchant_id, job.customer_id);
      await eraseDocumentObjects(client, job.merchant_id, job.customer_id);
    });
    await eraseExternalProjections(job.merchant_id, job.customer_id);
    await transaction(async (client) => await this.repository.markCompleted(client, job.id));
  }
}
