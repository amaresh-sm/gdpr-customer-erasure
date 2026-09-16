/**
 * Redacts customer-identifying fields from an arbitrary JSON value (event
 * payloads, queued job payloads, stored document snapshots) while preserving
 * its overall shape so financial fields (amount, currency, ids, totals)
 * remain intact. Used to scrub data that was written before an erasure
 * request completed, so delayed or replayed work cannot resurrect PII.
 */
export const ERASED_EMAIL = 'erased-customer@erased.invalid';
export const ERASED_NAME = 'Erased Customer';
export const ERASED_REFERENCE = 'erased';

const STATIC_REPLACEMENTS: Record<string, unknown> = {
  email: ERASED_EMAIL,
  customerEmail: ERASED_EMAIL,
  name: ERASED_NAME,
  billingName: ERASED_NAME,
  phone: null,
  externalReference: ERASED_REFERENCE,
  external_reference: ERASED_REFERENCE,
  line1: null,
  line2: null,
  city: null,
  region: null,
  postalCode: null,
  country: null,
  value: null,
  billingAddress: null,
  subject: 'Erased',
  body: 'Erased',
  metadata: {},
};

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(source)) {
      result[key] = key in STATIC_REPLACEMENTS ? STATIC_REPLACEMENTS[key] : redact(inner);
    }
    return result;
  }
  return value;
}

export function redactCustomerPayload<T>(value: T): T {
  return redact(value) as T;
}
