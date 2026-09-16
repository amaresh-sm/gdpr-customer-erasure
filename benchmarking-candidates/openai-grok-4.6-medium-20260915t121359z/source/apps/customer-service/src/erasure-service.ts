import { createHash } from 'node:crypto';
import { transaction } from '../../../packages/database/src/pool.js';
import {
  ErasureRepository,
  toPublicErasureRequest,
  type PublicErasureRequest,
} from './erasure-repository.js';

const IDEMPOTENCY_SCOPE = 'create-erasure-request';

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  async create(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<{ status: number; body: PublicErasureRequest }> {
    return transaction(async (client) => {
      const customer = await this.repository.findCustomer(client, merchantId, customerId);
      if (!customer) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });

      const hash = createHash('sha256').update(customerId).digest('hex');
      const replay = await reserveErasureIdempotency(client, merchantId, idempotencyKey, hash);
      if (replay) {
        const existing = await this.repository.findByCustomer(client, merchantId, customerId);
        if (existing) {
          const requeued = await this.repository.requeue(client, existing);
          return { status: 202, body: toPublicErasureRequest(requeued) };
        }
        return { status: replay.status, body: replay.body };
      }

      const existing = await this.repository.findByCustomer(client, merchantId, customerId);
      const request = existing
        ? await this.repository.requeue(client, existing)
        : await this.createExclusive(client, merchantId, customerId);
      const body = toPublicErasureRequest(request);
      await completeErasureIdempotency(client, merchantId, idempotencyKey, 202, body);
      return { status: 202, body };
    });
  }

  async get(merchantId: string, requestId: string): Promise<PublicErasureRequest | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? toPublicErasureRequest(row) : undefined;
  }

  private async createExclusive(
    client: import('pg').PoolClient,
    merchantId: string,
    customerId: string,
  ) {
    try {
      return await this.repository.create(client, merchantId, customerId);
    } catch (error) {
      const existing = await this.repository.findByCustomer(client, merchantId, customerId);
      if (existing) return this.repository.requeue(client, existing);
      throw error;
    }
  }
}

async function reserveErasureIdempotency(
  client: import('pg').PoolClient,
  merchantId: string,
  key: string,
  hash: string,
): Promise<{ status: number; body: PublicErasureRequest } | undefined> {
  const inserted = await client.query(
    `INSERT INTO operations.idempotency_keys(merchant_id,scope,key,request_hash,expires_at)
     VALUES($1,$2,$3,$4,now()+interval '24 hours') ON CONFLICT DO NOTHING`,
    [merchantId, IDEMPOTENCY_SCOPE, key, hash],
  );
  if (inserted.rowCount) return undefined;
  const existing = await client.query<{ request_hash: string; response_status: number | null; response_body: PublicErasureRequest }>(
    `SELECT request_hash,response_status,response_body FROM operations.idempotency_keys
     WHERE merchant_id=$1 AND scope=$2 AND key=$3 FOR UPDATE`,
    [merchantId, IDEMPOTENCY_SCOPE, key],
  );
  const row = existing.rows[0];
  if (!row || row.request_hash !== hash) {
    throw Object.assign(new Error('idempotency key reused with different request'), { statusCode: 409 });
  }
  if (row.response_status === null) return undefined;
  return { status: row.response_status, body: row.response_body };
}

async function completeErasureIdempotency(
  client: import('pg').PoolClient,
  merchantId: string,
  key: string,
  status: number,
  body: PublicErasureRequest,
): Promise<void> {
  await client.query(
    `UPDATE operations.idempotency_keys SET response_status=$4,response_body=$5
     WHERE merchant_id=$1 AND scope=$2 AND key=$3`,
    [merchantId, IDEMPOTENCY_SCOPE, key, status, body],
  );
}
