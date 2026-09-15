export const ERASURE_ERROR_CODES = [
  'database_unavailable',
  'storage_unavailable',
  'search_unavailable',
  'cache_unavailable',
  'mail_provider_unavailable',
  'erasure_failed',
] as const;

export type ErasureErrorCode = typeof ERASURE_ERROR_CODES[number];

/**
 * Raised by an erasure step so failures always carry a stable, customer-data-free
 * code. Never construct this with an interpolated message: the code is the only
 * thing persisted as `lastError`.
 */
export class ErasureStepError extends Error {
  constructor(readonly code: ErasureErrorCode, cause?: unknown) {
    super(code, { cause });
  }
}

/** Maps an arbitrary failure to a stable code safe to persist and expose. */
export function toErasureErrorCode(error: unknown): ErasureErrorCode {
  if (error instanceof ErasureStepError) return error.code;
  return 'erasure_failed';
}
