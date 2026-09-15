import { randomUUID } from 'node:crypto';
import { logger } from '../../observability/src/logger.js';
import { runErasureRequest } from './erasure.js';
import { erasureErrorCode } from './redaction.js';
import {
  claimRequest,
  markRequestCompleted,
  markRequestFailed,
  recoverExpiredErasureLeases,
} from './repository.js';

const LEASE_RECOVERY_INTERVAL_MS = 30_000;

/** Processes one accepted deletion request, if any is due. Returns whether work was done. */
export async function processNextErasureRequest(workerId: string): Promise<boolean> {
  const request = await claimRequest(workerId);
  if (!request) return false;
  try {
    await runErasureRequest(request);
    await markRequestCompleted(request);
    logger.info({ requestId: request.id }, 'customer data deletion completed');
  } catch (error) {
    const code = erasureErrorCode(error);
    await markRequestFailed(request, code);
    logger.error({ requestId: request.id, lastError: code }, 'customer data deletion attempt failed');
  }
  return true;
}

/**
 * Drains accepted deletion requests. Leases are recovered first so a request abandoned by a
 * crashed worker becomes runnable again and resumes from its unfinished step.
 */
export async function startErasureWorker(signal: AbortSignal, idleDelayMs = 250): Promise<void> {
  const workerId = `${process.env.SERVICE_NAME ?? 'service'}-erasure-${randomUUID()}`;
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() - lastLeaseRecovery > LEASE_RECOVERY_INTERVAL_MS) {
        await recoverExpiredErasureLeases();
        lastLeaseRecovery = Date.now();
      }
      if (!await processNextErasureRequest(workerId)) {
        await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
      }
    } catch (error) {
      logger.error({ error }, 'erasure worker dependency unavailable');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
