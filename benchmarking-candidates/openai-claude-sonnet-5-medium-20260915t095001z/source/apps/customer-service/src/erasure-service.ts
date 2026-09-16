import { transaction } from '../../../packages/database/src/pool.js';
import { completeIdempotency, requestHash, reserveIdempotency } from '../../../packages/operations/src/idempotency.js';
import { CustomerRepository } from './repository.js';
import { ERASURE_QUEUE } from './erasure-worker.js';
import { ErasureRepository, type ErasureRequestRow } from './erasure-repository.js';

const IDEMPOTENCY_SCOPE = 'erasure-request';

export interface ErasureRequestBody {
  id: string;
  customerId: string;
  status: ErasureRequestRow['status'];
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

function toBody(row: ErasureRequestRow): ErasureRequestBody {
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

export class ErasureService {
  constructor(
    private readonly repository = new ErasureRepository(),
    private readonly customers = new CustomerRepository(),
  ) {}

  async requestErasure(merchantId: string, customerId: string, idempotencyKey: string): Promise<{ status: number; body: ErasureRequestBody }> {
    const customer = await this.customers.find(merchantId, customerId);
    if (!customer) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });

    const hash = requestHash({ customerId });
    const result = await transaction(async (client) => {
      const replay = await reserveIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, hash);
      if (replay) return { body: replay.body as ErasureRequestBody, status: replay.status, fresh: false };

      const existing = await this.repository.findByCustomer(merchantId, customerId);
      if (existing) {
        await this.repository.reviveJobIfDead(client, existing.job_id);
        const body = toBody(existing);
        await completeIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, 202, body);
        return { body, status: 202, fresh: false };
      }

      const created = await this.repository.create(client, merchantId, customerId);
      const job = await client.query<{ id: string }>(
        `INSERT INTO operations.jobs(queue,job_type,merchant_id,payload,max_attempts)
         VALUES($1,'customer.erasure',$2,$3,20) RETURNING id`,
        [ERASURE_QUEUE, merchantId, { requestId: created.id, merchantId, customerId }],
      );
      await this.repository.attachJob(client, created.id, job.rows[0]!.id);
      const body = toBody({ ...created, job_id: job.rows[0]!.id });
      await completeIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, 202, body);
      return { body, status: 202, fresh: true };
    });
    return { status: result.status, body: result.body };
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequestBody | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? toBody(row) : undefined;
  }
}
