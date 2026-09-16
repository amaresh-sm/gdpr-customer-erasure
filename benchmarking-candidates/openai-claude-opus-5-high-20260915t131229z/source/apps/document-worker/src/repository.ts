import type { PoolClient } from 'pg';

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
