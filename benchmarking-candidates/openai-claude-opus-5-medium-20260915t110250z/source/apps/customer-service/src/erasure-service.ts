import { transaction } from '../../../packages/database/src/pool.js';
import {
  completeIdempotency,
  requestHash,
  reserveIdempotency,
} from '../../../packages/operations/src/idempotency.js';
import { ErasureRepository, type ErasureRequestRow } from './erasure-repository.js';

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

const IDEMPOTENCY_SCOPE = 'erasure-request';

export function toErasureRequestView(row: ErasureRequestRow): ErasureRequestView {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  /**
   * Accepts a deletion request for the customer. A customer has at most one request, so a repeated
   * call converges on the request that already exists instead of starting a second workflow.
   */
  async request(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<{ status: number; body: ErasureRequestView }> {
    const hash = requestHash({ customerId });
    return await transaction(async (client) => {
      const replay = await reserveIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, hash);
      if (replay) return { status: replay.status, body: replay.body as ErasureRequestView };

      // Rolling back this transaction also releases the reserved key, so a request for an unknown
      // customer leaves no trace and reveals nothing about other merchants' data.
      const existing = await this.repository.findByCustomer(client, merchantId, customerId);
      const row = existing ?? await this.repository.create(client, merchantId, customerId);
      if (!row) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });

      const body = toErasureRequestView(row);
      await completeIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, 202, body);
      return { status: 202, body };
    });
  }

  async get(merchantId: string, requestId: string): Promise<ErasureRequestView | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? toErasureRequestView(row) : undefined;
  }
}
