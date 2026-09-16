/**
 * The fields that carry a customer's identity. Everything else in a retained record — identifiers,
 * amounts, currencies, statuses, timestamps — is a financial fact PayFlow keeps.
 *
 * Kept in sync with the `privacy.redact_payload` SQL function used for in-database redaction.
 */
const IDENTIFYING_KEYS = new Set([
  'email', 'customerEmail', 'name', 'displayName', 'phone', 'externalReference', 'external_reference',
  'metadata', 'customer', 'customerSnapshot', 'customer_snapshot', 'billingName', 'billing_name',
  'billingAddress', 'billing_address', 'brand', 'last4', 'providerToken', 'provider_token',
  'destination', 'subject', 'body', 'notes', 'value', 'address', 'line1', 'line2', 'city', 'region',
  'postalCode', 'postal_code', 'country',
]);

/**
 * Returns the payload with customer-identifying fields removed from its top level, marked so that
 * readers of the retained record can tell the omission is deliberate.
 */
export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const retained = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !IDENTIFYING_KEYS.has(key)),
  );
  return { ...retained, customerErased: true };
}

/**
 * Removes customer-identifying fields at every depth of a retained document, leaving the financial
 * facts that the document exists to record.
 */
export function redactDocument(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDocument);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !IDENTIFYING_KEYS.has(key))
      .map(([key, nested]) => [key, redactDocument(nested)]),
  );
}

/** Reports whether a stored document still refers to the customer being erased. */
export function documentReferencesCustomer(
  document: string,
  customerId: string,
  email: string | null,
): boolean {
  return document.includes(customerId) || (email !== null && document.includes(email));
}
