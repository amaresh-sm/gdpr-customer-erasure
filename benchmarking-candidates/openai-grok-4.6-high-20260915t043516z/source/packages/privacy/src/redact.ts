export const REDACTED = '[REDACTED]';

const PII_KEYS = new Set([
  'email', 'customeremail', 'name', 'billingname', 'phone', 'destination',
  'line1', 'line2', 'city', 'region', 'postalcode', 'postal_code',
  'billingaddress', 'billing_address', 'billing_name', 'customer_email',
  'externalreference', 'external_reference', 'providertoken', 'provider_token',
]);

export function erasedEmail(customerId: string): string {
  return `erased-${customerId}@erased.invalid`;
}

export function erasedReference(customerId: string): string {
  return `erased-${customerId}`;
}

export function redactedCustomerRecord(customerId: string): Record<string, unknown> {
  return {
    id: customerId,
    email: erasedEmail(customerId),
    name: REDACTED,
    phone: null,
    external_reference: erasedReference(customerId),
    status: 'erased',
    metadata: {},
  };
}

/** Collects identifying strings that must not remain after deletion. */
export function collectPiiValues(values: Array<string | null | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) unique.add(trimmed);
  }
  return [...unique].sort((left, right) => right.length - left.length);
}

function isPiiKey(key: string): boolean {
  return PII_KEYS.has(key.toLowerCase().replaceAll('_', ''));
}

function scrubString(value: string, piiValues: string[]): string {
  let result = value;
  for (const candidate of piiValues) {
    if (candidate.length < 3) continue;
    if (result.includes(candidate)) result = result.split(candidate).join(REDACTED);
  }
  return result;
}

/** Removes known personal data from nested JSON while leaving financial facts intact. */
export function redactJson(value: unknown, piiValues: string[] = []): unknown {
  if (typeof value === 'string') return scrubString(value, piiValues);
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, piiValues));
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isPiiKey(key)) {
      if (key.toLowerCase() === 'phone') {
        result[key] = null;
      } else if (entry && typeof entry === 'object') {
        result[key] = redactJson(entry, piiValues);
      } else {
        result[key] = REDACTED;
      }
      continue;
    }
    result[key] = redactJson(entry, piiValues);
  }
  return result;
}

export function redactText(value: string | null | undefined, piiValues: string[]): string | null {
  if (value == null) return null;
  return scrubString(value, piiValues);
}

/** Replaces known identifying strings without deleting unrelated financial fields. */
export function redactJsonValues(value: unknown, piiValues: string[]): unknown {
  if (typeof value === 'string') return scrubString(value, piiValues);
  if (Array.isArray(value)) return value.map((entry) => redactJsonValues(entry, piiValues));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = redactJsonValues(entry, piiValues);
  }
  return result;
}
