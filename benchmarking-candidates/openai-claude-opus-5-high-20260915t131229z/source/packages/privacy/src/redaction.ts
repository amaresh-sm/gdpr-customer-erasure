/**
 * Personal-data property names shared by stored documents and JSON columns. The
 * SQL counterpart lives in `privacy.is_pii_key` and must list the same names.
 */
const PII_KEYS = new Set([
  'email', 'emails', 'customeremail', 'customer_email', 'destination', 'destinations', 'recipient', 'to',
  'name', 'customername', 'customer_name', 'displayname', 'display_name', 'billingname', 'billing_name',
  'firstname', 'first_name', 'lastname', 'last_name', 'fullname', 'full_name',
  'phone', 'phonenumber', 'phone_number', 'mobile',
  'address', 'addresses', 'billingaddress', 'billing_address', 'shippingaddress', 'shipping_address',
  'line1', 'line2', 'city', 'region', 'state', 'postalcode', 'postal_code', 'zip', 'country',
  'externalreference', 'external_reference', 'metadata', 'properties',
  'customer', 'customersnapshot', 'customer_snapshot', 'billingsnapshot', 'billing_snapshot',
  'contact', 'contacts', 'body', 'textbody', 'text_body', 'htmlbody', 'html_body', 'subject', 'value',
  'notes', 'note', 'last4', 'brand', 'providertoken', 'provider_token', 'ip', 'ipaddress', 'ip_address',
  'anonymousid', 'anonymous_id',
]);

export function isPiiKey(key: string): boolean {
  return PII_KEYS.has(key.toLowerCase());
}

/** Drops personal-data values while preserving identifiers and monetary facts. */
export function redactPii(document: unknown): unknown {
  if (Array.isArray(document)) return document.map((element) => redactPii(element));
  if (document === null || typeof document !== 'object') return document;
  return Object.fromEntries(
    Object.entries(document as Record<string, unknown>)
      .map(([key, value]) => [key, isPiiKey(key) ? null : redactPii(value)]),
  );
}
