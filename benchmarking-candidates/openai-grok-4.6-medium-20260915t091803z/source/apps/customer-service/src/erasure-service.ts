import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type pg from 'pg';
import { transaction } from '../../../packages/database/src/pool.js';
import { toErasureResponse, type ErasureRequestResponse } from '../../../packages/privacy/src/erasure-contract.js';
import { ErasureRepository } from './erasure-repository.js';

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  async create(merchantId: string, customerId: string, idempotencyKey: string): Promise<ErasureRequestResponse> {
    const customer = await this.repository.findCustomer(merchantId, customerId);
    if (!customer) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });

    const hash = requestHash({ customerId });
    return transaction(async (client) => {
      const replay = await reserveIdempotency(client, merchantId, 'create-erasure-request', idempotencyKey, hash);
      const existing = await this.repository.findByCustomer(client, merchantId, customerId);
      if (existing) {
        const current = existing.status === 'failed'
          ? await this.repository.requeue(client, existing.id) ?? existing
          : existing;
        if (!replay) {
          await completeIdempotency(client, merchantId, 'create-erasure-request', idempotencyKey, 202, toErasureResponse(current));
        }
        await this.repository.audit(client, merchantId, customerId, 'customer.erasure.resumed', uuid(), { requestId: current.id });
        return toErasureResponse(current);
      }

      if (replay) return replay.body as ErasureRequestResponse;

      const created = await this.repository.create(client, merchantId, customerId);
      const body = toErasureResponse(created);
      await completeIdempotency(client, merchantId, 'create-erasure-request', idempotencyKey, 202, body);
      await this.repository.audit(client, merchantId, customerId, 'customer.erasure.requested', uuid(), { requestId: created.id });
      return body;
    });
  }

  async get(merchantId: string, requestId: string): Promise<ErasureRequestResponse | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? toErasureResponse(row) : undefined;
  }
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function reserveIdempotency(
  client: pg.PoolClient,
  merchantId: string,
  scope: string,
  key: string,
  hash: string,
): Promise<{ status: number; body: unknown } | undefined> {
  const inserted = await client.query(
    `INSERT INTO operations.idempotency_keys(merchant_id,scope,key,request_hash,expires_at)
     VALUES($1,$2,$3,$4,now()+interval '24 hours') ON CONFLICT DO NOTHING`,
    [merchantId, scope, key, hash],
  );
  if (inserted.rowCount) return undefined;
  const existing = await client.query<{ request_hash: string; response_status: number | null; response_body: unknown }>(
    `SELECT request_hash,response_status,response_body FROM operations.idempotency_keys
     WHERE merchant_id=$1 AND scope=$2 AND key=$3 FOR UPDATE`,
    [merchantId, scope, key],
  );
  const row = existing.rows[0];
  if (!row || row.request_hash !== hash) {
    throw Object.assign(new Error('idempotency key reused with different request'), { statusCode: 409 });
  }
  if (row.response_status === null) {
    throw Object.assign(new Error('request with this idempotency key is in progress'), { statusCode: 409 });
  }
  return { status: row.response_status, body: row.response_body };
}

async function completeIdempotency(
  client: pg.PoolClient, merchantId: string, scope: string, key: string, status: number, body: unknown,
): Promise<void> {
  await client.query(
    `UPDATE operations.idempotency_keys SET response_status=$4,response_body=$5
     WHERE merchant_id=$1 AND scope=$2 AND key=$3`,
    [merchantId, scope, key, status, body],
  );
}
