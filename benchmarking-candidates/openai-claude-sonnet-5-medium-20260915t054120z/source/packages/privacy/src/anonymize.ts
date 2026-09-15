/**
 * Deterministic, PII-free replacement values used when erasing a customer.
 * Every value is derived only from the customer id so re-running erasure
 * (retries, restarts) always converges on the same redacted state.
 */

export const REDACTED_NAME = 'Redacted Customer';

export function redactedEmail(customerId: string): string {
  return `deleted-${customerId}@erased.payflow.invalid`;
}

export function redactedExternalReference(customerId: string): string {
  return `erased-${customerId}`;
}

export interface CustomerLikeSnapshot {
  id?: unknown;
  email?: unknown;
  name?: unknown;
  phone?: unknown;
  external_reference?: unknown;
  externalReference?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

/**
 * Redacts the PII fields of a flat customer-shaped snapshot (as stored in
 * `payments.payment_intents.customer_snapshot` and
 * `payments.invoices.billing_snapshot`) while preserving any non-PII fields
 * needed to keep the record financially meaningful.
 */
export function anonymizeCustomerSnapshot<T extends CustomerLikeSnapshot>(snapshot: T, customerId: string): T {
  const next: T = { ...snapshot };
  next.email = redactedEmail(customerId);
  next.name = REDACTED_NAME;
  next.phone = null;
  if ('external_reference' in next) next.external_reference = redactedExternalReference(customerId);
  if ('externalReference' in next) next.externalReference = redactedExternalReference(customerId);
  return next;
}

/**
 * Redacts a stored document body (receipts, invoices) that embeds the
 * customer profile under a `customer` key, preserving the surrounding
 * financial fields (amounts, line items, identifiers).
 */
export function anonymizeStoredDocument(document: Record<string, unknown>, customerId: string): Record<string, unknown> {
  const customer = document.customer;
  if (!customer || typeof customer !== 'object') return document;
  return { ...document, customer: anonymizeCustomerSnapshot(customer as CustomerLikeSnapshot, customerId) };
}
