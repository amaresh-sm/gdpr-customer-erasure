import { createHash } from 'node:crypto';

export const ERASURE_IDEMPOTENCY_SCOPE = 'privacy-erasure-request';
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string'
    && key.length >= IDEMPOTENCY_KEY_MIN_LENGTH
    && key.length <= IDEMPOTENCY_KEY_MAX_LENGTH;
}

/**
 * Binding value stored with an idempotency key. Comparing it detects a key that is being
 * replayed against a different customer, which must never be treated as the same request.
 */
export function customerFingerprint(customerId: string): string {
  return createHash('sha256').update(customerId).digest('hex');
}
