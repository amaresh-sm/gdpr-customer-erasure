const PII_KEYS = new Set([
  'address', 'authorid', 'billingaddress', 'billingname', 'billing_snapshot', 'canary',
  'body', 'customer', 'customeremail', 'customerid', 'customersnapshot', 'description',
  'destination', 'email', 'externalreference', 'external_reference', 'line1', 'line2',
  'metadata', 'name', 'phone', 'postalcode', 'postal_code', 'profile', 'providercustomerid',
  'provider_customer_id', 'reason', 'subject', 'value',
]);

export function redactPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPii);
  if (!value || typeof value !== 'object') return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!PII_KEYS.has(key.toLowerCase())) redacted[key] = redactPii(child);
  }
  return redacted;
}

export function retainedCustomerSnapshot(): Record<string, unknown> {
  return { erased: true };
}
