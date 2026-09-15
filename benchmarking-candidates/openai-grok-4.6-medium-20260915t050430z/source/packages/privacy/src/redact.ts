const PII_KEYS = new Set([
  'email',
  'customerEmail',
  'name',
  'phone',
  'externalReference',
  'external_reference',
  'billingName',
  'billing_name',
  'billingAddress',
  'billing_address',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'postal_code',
  'body',
  'subject',
  'value',
  'destination',
  'providerToken',
  'provider_token',
  'last4',
  'text_body',
  'html_body',
  'textBody',
  'htmlBody',
  'notes',
]);

const CUSTOMER_OBJECT_KEYS = new Set(['customer', 'customerSnapshot', 'customer_snapshot']);

export function anonymizedCustomerIdentity(customerId: string): {
  email: string;
  name: string;
  phone: null;
  externalReference: string;
  metadata: Record<string, never>;
} {
  return {
    email: `erased-${customerId}@erased.invalid`,
    name: 'Erased Customer',
    phone: null,
    externalReference: `erased:${customerId}`,
    metadata: {},
  };
}

export function anonymizedCustomerSnapshot(customerId: string): Record<string, unknown> {
  return { id: customerId, erased: true };
}

export function stripPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPii);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (CUSTOMER_OBJECT_KEYS.has(key)) {
      result[key] = anonymizeCustomerObject(nested);
      continue;
    }
    if (PII_KEYS.has(key)) {
      result[key] = null;
      continue;
    }
    result[key] = stripPii(nested);
  }
  return result;
}

function anonymizeCustomerObject(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { erased: true };
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' ? anonymizedCustomerSnapshot(record.id) : { erased: true };
}
