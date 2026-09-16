/**
 * Cleanup runs as an ordered list of named steps. Each finished step is recorded on the request, so
 * a retry after a crash resumes instead of repeating destructive work, and every step is written to
 * be idempotent so repeating one is still safe.
 *
 * The order matters: systems that need the customer's identity to find their data (object storage,
 * captured email) run before the profile that holds that identity is removed.
 */
export const ERASURE_STEPS = [
  'search_projection',
  'cache_projection',
  'analytics',
  'object_storage',
  'email_history',
  'event_history',
  'support',
  'provider_profiles',
  'financial_records',
  'customer_profile',
] as const;

export type ErasureStep = (typeof ERASURE_STEPS)[number];

export const ERASURE_LEASE_SECONDS = 60;

/** Returns the steps still outstanding, preserving the order cleanup must follow. */
export function remainingErasureSteps(completed: readonly string[]): ErasureStep[] {
  return ERASURE_STEPS.filter((step) => !completed.includes(step));
}

export function isErasureComplete(completed: readonly string[]): boolean {
  return remainingErasureSteps(completed).length === 0;
}

/**
 * `lastError` is exposed to merchants and stored, so it must stay a stable code. Provider messages
 * and database errors can quote the row that failed, which is exactly the personal data being
 * deleted, so the failing step name is all that is ever recorded.
 */
export function erasureFailureCode(step: ErasureStep): string {
  return `${step}_failed`;
}

export const ERASURE_LEASE_EXPIRED = 'lease_expired';

/**
 * Keys that carry personal data in event, job, and document payloads. Retained rows keep their
 * structural and financial keys (identifiers, amounts, currencies, statuses) and lose these.
 */
export const PII_PAYLOAD_KEYS = [
  'email',
  'customerEmail',
  'destination',
  'name',
  'billingName',
  'phone',
  'externalReference',
  'metadata',
  'customer',
  'customerSnapshot',
  'billingAddress',
  'value',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'subject',
  'body',
  'brand',
  'last4',
] as const;

/** Replaces a stored personal-data snapshot on a record PayFlow must retain. */
export const REDACTED_SNAPSHOT = { erased: true } as const;

/**
 * Rewrites a stored document so the financial facts it proves survive without identifying the
 * customer. Keys holding personal data are dropped rather than blanked, so a later reader cannot
 * mistake an empty string for the customer's real details.
 */
export function redactDocument(document: unknown): Record<string, unknown> {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { ...REDACTED_SNAPSHOT };
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
    if ((PII_PAYLOAD_KEYS as readonly string[]).includes(key)) continue;
    result[key] = value;
  }
  result.customer = { ...REDACTED_SNAPSHOT };
  return result;
}
