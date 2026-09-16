/**
 * Pure helpers for redacting personal data. Kept side-effect free so the same rules can be
 * unit tested and reused everywhere a customer snapshot or billing record is anonymized.
 */

export const ERASED_EMAIL_DOMAIN = 'deleted.payflow.invalid';
export const ERASED_NAME = 'Erased Customer';

/** A stable, non-identifying placeholder email that keeps the merchant's email uniqueness constraint intact. */
export function erasedEmailFor(customerId: string): string {
  return `erased-${customerId}@${ERASED_EMAIL_DOMAIN}`;
}

const PII_KEYS = new Set(['email', 'name', 'phone', 'externalReference', 'external_reference', 'metadata', 'billingName', 'billing_name', 'billingAddress', 'billing_address']);

/**
 * Redacts personal fields embedded in a financial JSON snapshot (payment/invoice records)
 * while preserving every other field so the record stays financially meaningful.
 */
export function redactSnapshot<T extends Record<string, unknown>>(snapshot: T, customerId: string): T {
  const redacted: Record<string, unknown> = { ...snapshot };
  for (const key of Object.keys(redacted)) {
    if (!PII_KEYS.has(key)) continue;
    if (key === 'email') redacted[key] = erasedEmailFor(customerId);
    else if (key === 'name') redacted[key] = ERASED_NAME;
    else if (key === 'metadata') redacted[key] = {};
    else redacted[key] = null;
  }
  return redacted as T;
}

export function isValidIdempotencyKey(key: string): boolean {
  return key.length >= 8 && key.length <= 200;
}
