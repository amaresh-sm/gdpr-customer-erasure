export const REDACTED = 'REDACTED';

export const PII_KEYS = new Set([
  'email',
  'name',
  'phone',
  'customerEmail',
  'billingName',
  'billingAddress',
  'billing_name',
  'billing_address',
  'external_reference',
  'externalReference',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'postal_code',
  'country',
  'destination',
  'body',
  'subject',
  'value',
  'text_body',
  'html_body',
  'textBody',
  'htmlBody',
]);

export function isPiiKey(key: string): boolean {
  return PII_KEYS.has(key);
}

export function redactJson<T>(value: T): T {
  return redactUnknown(value) as T;
}

export function anonymizedCustomerFields(customerId: string): {
  email: string;
  name: string;
  phone: null;
  external_reference: string;
} {
  return {
    email: erasedEmail(customerId),
    name: REDACTED,
    phone: null,
    external_reference: erasedReference(customerId),
  };
}

export function erasedEmail(customerId: string): string {
  return `erased+${customerId}@invalid.example`;
}

export function erasedReference(customerId: string): string {
  return `erased-${customerId}`;
}

export function anonymizedProjection(merchantId: string, customerId: string): {
  merchantId: string;
  customerId: string;
  email: string;
  name: string;
  phone: null;
  updatedAt: string;
} {
  return {
    merchantId,
    customerId,
    email: erasedEmail(customerId),
    name: REDACTED,
    phone: null,
    updatedAt: new Date().toISOString(),
  };
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
      if (!isPiiKey(key)) return [key, redactUnknown(nested)];
      if (nested === null || nested === undefined) return [key, null];
      if (typeof nested === 'object') return [key, redactUnknown(nested)];
      return [key, REDACTED];
    });
    return Object.fromEntries(entries);
  }
  return value;
}
