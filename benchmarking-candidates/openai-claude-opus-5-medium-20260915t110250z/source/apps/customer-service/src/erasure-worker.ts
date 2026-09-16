import { randomUUID } from 'node:crypto';
import { transaction } from '../../../packages/database/src/pool.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { ErasureRepository, type ErasureRequestRow } from './erasure-repository.js';
import { ERASURE_STEPS, type ErasureTarget } from './erasure-steps.js';

const STEP_ERROR_CODES: Record<string, string> = {
  tombstone: 'erasure_tombstone_failed',
  search: 'erasure_search_cleanup_failed',
  cache: 'erasure_cache_cleanup_failed',
  objects: 'erasure_object_cleanup_failed',
  messaging: 'erasure_messaging_cleanup_failed',
  records: 'erasure_record_cleanup_failed',
};

/** Maps a failure to a stable, customer-data-free code that is safe to return to the merchant. */
function errorCode(step: string): string {
  return STEP_ERROR_CODES[step] ?? 'erasure_failed';
}

export class ErasureWorker {
  private readonly workerId = `erasure-worker-${randomUUID()}`;

  constructor(private readonly repository = new ErasureRepository()) {}

  /**
   * Runs the unfinished steps of one claimed request. Steps are recorded as they succeed, so a
   * failure leaves the request retryable and a later attempt resumes without repeating work.
   */
  async process(request: ErasureRequestRow): Promise<void> {
    const completed = await this.repository.completedSteps(request.id);
    const subject = await this.repository.subject(request.merchant_id, request.customer_id);
    const target: ErasureTarget = {
      requestId: request.id,
      merchantId: request.merchant_id,
      customerId: request.customer_id,
      subject,
    };
    for (const step of ERASURE_STEPS) {
      if (completed.has(step.name)) continue;
      try {
        await step.run(target);
      } catch (error) {
        logger.error({ error, requestId: request.id, step: step.name }, 'erasure step failed');
        await this.repository.fail(request, errorCode(step.name));
        return;
      }
      await transaction((client) => this.repository.recordStep(client, request.id, step.name));
    }
    await this.repository.complete(request.id);
  }

  async runOnce(): Promise<boolean> {
    const request = await this.repository.claim(this.workerId);
    if (!request) return false;
    await this.process(request);
    return true;
  }

  /** Drains available requests, recovering work abandoned by a crashed or restarted worker. */
  async run(signal: AbortSignal): Promise<void> {
    let lastLeaseRecovery = 0;
    while (!signal.aborted) {
      try {
        if (Date.now() - lastLeaseRecovery > 30_000) {
          await this.repository.recoverExpiredLeases();
          lastLeaseRecovery = Date.now();
        }
        if (!await this.runOnce()) await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (error) {
        logger.error({ error }, 'erasure worker iteration failed');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
}
