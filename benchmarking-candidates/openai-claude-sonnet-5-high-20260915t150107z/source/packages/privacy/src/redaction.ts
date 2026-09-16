/**
 * Deterministic, collision-free placeholders used to anonymize a customer's
 * identity fields in place. Deterministic output means every retry of an
 * erasure attempt converges on the exact same values, so re-running a step
 * is always a safe no-op rather than a source of drift.
 */
export const ERASED_NAME = 'Erased Customer';
export const ERASED_STATUS = 'erased';
export const REDACTED_TEXT = '[redacted]';

export function erasedEmail(customerId: string): string {
  return `erased+${customerId}@erased.payflow.invalid`;
}

export function erasedExternalReference(customerId: string): string {
  return `erased-${customerId}`;
}

/** Stable, customer-data-free error codes safe to surface through the public API. */
export type ErasureErrorCode =
  | 'database_unavailable'
  | 'object_storage_unavailable'
  | 'search_index_unavailable'
  | 'cache_unavailable'
  | 'mail_provider_unavailable'
  | 'erasure_processing_failed';

export class ErasureStepError extends Error {
  constructor(readonly code: ErasureErrorCode, cause?: unknown) {
    super(code, { cause });
  }
}

/** Maps any failure raised while processing an erasure request to a stable, PII-free error code. */
export function classifyErasureError(error: unknown): ErasureErrorCode {
  if (error instanceof ErasureStepError) return error.code;
  return 'erasure_processing_failed';
}
