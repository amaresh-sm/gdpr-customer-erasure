import { randomUUID } from 'node:crypto';
import { completeIdempotency, requestHash, reserveIdempotency } from '../../../packages/http/src/idempotency.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureRepository, type ClaimedErasureRequest, type ErasureRequestRow } from './erasure-repository.js';
import { ErasureScrubRepository } from './erasure-scrub-repository.js';
import { purgeProjections, redactStoredDocuments } from './erasure-storage.js';

const IDEMPOTENCY_SCOPE = 'erasure-request';

export function toResponseBody(request: ErasureRequestRow): Record<string, unknown> {
  return {
    id: request.id,
    customerId: request.customer_id,
    status: request.status,
    attempts: request.attempts,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
    completedAt: request.completed_at,
    lastError: request.last_error,
  };
}

export class ErasureService {
  constructor(
    private readonly repository = new ErasureRepository(),
    private readonly scrubber = new ErasureScrubRepository(),
  ) {}

  /**
   * Accepts a data deletion request. Returns the saved request. Reuses the
   * customer's existing request instead of starting a duplicate workflow,
   * and relies on idempotency-key reservation to make replays and
   * cross-customer key reuse safe.
   */
  async accept(merchantId: string, customerId: string, idempotencyKey: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const hash = requestHash({ customerId });
    return await transaction(async (client) => {
      const replay = await reserveIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, hash);
      if (replay) return { status: replay.status, body: replay.body as Record<string, unknown> };

      // Locking the customer row first serializes concurrent accept() calls for the
      // same customer, so the existing-request check below can never race with a
      // concurrent insert and violate the (merchant_id,customer_id) uniqueness.
      const customer = await this.repository.lockCustomer(client, merchantId, customerId);
      if (!customer) throw Object.assign(new Error('customer not found'), { statusCode: 404 });

      const existing = await this.repository.findByCustomer(client, merchantId, customerId);
      if (existing) {
        const body = toResponseBody(existing);
        await completeIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, 202, body);
        return { status: 202, body };
      }

      const created = await this.repository.create(client, merchantId, customerId);
      const body = toResponseBody(created);
      await completeIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, 202, body);
      return { status: 202, body };
    });
  }

  async find(merchantId: string, requestId: string): Promise<Record<string, unknown> | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? toResponseBody(row) : undefined;
  }

  /** Processes one claimed erasure request end to end. Every step is safe to re-run after a crash or retry. */
  async process(request: ClaimedErasureRequest): Promise<void> {
    try {
      const documents = await transaction(async (client) => {
        return await this.scrubber.scrub(client, request.merchant_id, request.customer_id);
      });
      await redactStoredDocuments(documents);
      await purgeProjections(request.merchant_id, request.customer_id);
      await transaction(async (client) => await this.repository.complete(client, request.id));
    } catch (error) {
      logger.error({ error, requestId: request.id }, 'erasure request processing failed');
      await this.repository.fail(request, error);
    }
  }
}

export async function runErasureWorker(signal: AbortSignal): Promise<void> {
  const repository = new ErasureRepository();
  const service = new ErasureService(repository);
  const workerId = `erasure-worker-${randomUUID()}`;
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastLeaseRecovery > 30_000) {
      await repository.recoverExpiredLeases();
      lastLeaseRecovery = Date.now();
    }
    const request = await repository.claim(workerId);
    if (!request) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    await service.process(request);
  }
}
