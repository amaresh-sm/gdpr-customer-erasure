import type { PoolClient } from 'pg';
import { pool } from '../../../packages/database/src/pool.js';

export async function isCustomerActive(merchantId: string, customerId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2 AND status='active'`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

export async function recordReceiptManifest(
  client: PoolClient,
  input: {
    merchantId: string;
    customerId: string;
    paymentId: string;
    objectKey: string;
    checksum: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO operations.document_manifests
     (merchant_id,customer_id,object_key,document_type,content_type,checksum,metadata)
     VALUES($1,$2,$3,'receipt','application/json',$4,$5) ON CONFLICT(object_key) DO NOTHING`,
    [input.merchantId, input.customerId, input.objectKey, input.checksum, { paymentId: input.paymentId }],
  );
}
