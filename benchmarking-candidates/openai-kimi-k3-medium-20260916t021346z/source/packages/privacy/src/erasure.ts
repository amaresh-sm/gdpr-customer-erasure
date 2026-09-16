/** Lock key shared by the erasure worker and every writer that must serialize with it. */
export function erasureLockKey(merchantId: string, customerId: string): string {
  return `customer-erasure:${merchantId}:${customerId}`;
}

/** PII-free projection kept for an erased customer so derived stores stay consistent. */
export function erasedCustomerProjection(merchantId: string, customerId: string): Record<string, unknown> {
  return { merchantId, customerId, erased: true, updatedAt: new Date().toISOString() };
}

/**
 * Returns the document with its customer block replaced by a tombstone, or null when the
 * document does not carry customer data that still needs scrubbing.
 */
export function scrubStoredDocument(body: string): string | null {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof document !== 'object' || document === null || !('customer' in document)) return null;
  const customer = (document as { customer?: unknown }).customer;
  if (typeof customer === 'object' && customer !== null && (customer as { erased?: unknown }).erased === true) return null;
  return JSON.stringify({ ...(document as Record<string, unknown>), customer: { erased: true } });
}

export interface ErasureIdentifiers {
  customerId: string;
  email: string | null;
  externalReference: string | null;
}

/** Checks whether an arbitrary imported artifact references the erased customer. */
export function importReferencesCustomer(body: string, identifiers: ErasureIdentifiers): boolean {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return false;
  }
  const needles = [identifiers.customerId, identifiers.email, identifiers.externalReference]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (!needles.length) return false;
  const stack: unknown[] = [document];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === 'string' && needles.includes(current)) return true;
    if (Array.isArray(current)) stack.push(...current);
    else if (typeof current === 'object' && current !== null) stack.push(...Object.values(current));
  }
  return false;
}

/** Stable erasure failure codes; they must never contain customer data. */
export const ERASURE_ERROR_CODES = [
  'database_cleanup_failed',
  'object_store_cleanup_failed',
  'cache_cleanup_failed',
  'search_cleanup_failed',
] as const;

export type ErasureErrorCode = (typeof ERASURE_ERROR_CODES)[number];

export class ErasureStepError extends Error {
  constructor(readonly code: ErasureErrorCode, cause: unknown) {
    super(code, { cause });
  }
}
