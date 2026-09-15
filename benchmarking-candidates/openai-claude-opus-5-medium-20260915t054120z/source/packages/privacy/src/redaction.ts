/**
 * Canonical shape written over customer snapshots that stay attached to retained
 * financial records. The pseudonymous customer id is kept so payments, invoices and
 * ledger entries remain groupable and auditable; every attribute that identifies a
 * person is dropped.
 */
export interface RedactedCustomerSnapshot {
  id: string;
  status: 'erased';
  email: null;
  name: null;
  phone: null;
  external_reference: null;
  erased: true;
}

export function redactedCustomerSnapshot(customerId: string): RedactedCustomerSnapshot {
  return {
    id: customerId,
    status: 'erased',
    email: null,
    name: null,
    phone: null,
    external_reference: null,
    erased: true,
  };
}

/** Placeholder left in retained free-text fields whose original wording described a person. */
export const REDACTED_TEXT = 'redacted';

/**
 * Attribute names that carry personal data in event payloads, job arguments and stored
 * documents. Merchant-supplied free text is included: a payment or invoice line description
 * routinely names the person it was raised for.
 */
export const PII_ATTRIBUTES: string[] = [
  'email', 'customerEmail', 'destination', 'name', 'billingName', 'phone', 'externalReference',
  'metadata', 'line1', 'line2', 'city', 'region', 'postalCode', 'country', 'value', 'subject',
  'body', 'attachments', 'description', 'notes', 'last4', 'billingAddress', 'customerSnapshot',
  'customer',
];

const PII_ATTRIBUTE_SET = new Set(PII_ATTRIBUTES);

/**
 * Rewrites a stored document so no attribute at any depth identifies the subject, while the
 * financial figures around it — amounts, quantities, totals, currencies and dates — survive
 * untouched.
 */
export function redactDocument(value: unknown, customerId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactDocument(item, customerId));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'customer' || key === 'customerSnapshot') result[key] = redactedCustomerSnapshot(customerId);
    else if (PII_ATTRIBUTE_SET.has(key)) result[key] = nested === null ? null : REDACTED_TEXT;
    else result[key] = redactDocument(nested, customerId);
  }
  return result;
}

/**
 * Names of the erasure steps, in the order the workflow must run them. Steps that need an
 * attribute of the subject to find data elsewhere run before the step that deletes it, so
 * the workflow never has to stash personal data of its own.
 */
export const ERASURE_STEPS = [
  'block_new_processing',
  'purge_captured_mail',
  'stop_pending_delivery',
  'redact_financial_records',
  'redact_stored_documents',
  'delete_customer_relations',
  'delete_analytics_and_messaging',
  'purge_projections',
  'delete_customer_record',
] as const;

export type ErasureStep = (typeof ERASURE_STEPS)[number];

/**
 * Stable, customer-free failure codes reported through `lastError`. They describe the
 * step that has to be retried, never the data the step was working on.
 */
export const ERASURE_ERROR_CODES: Readonly<Record<ErasureStep, string>> = {
  block_new_processing: 'block_new_processing_failed',
  purge_captured_mail: 'purge_captured_mail_failed',
  stop_pending_delivery: 'stop_pending_delivery_failed',
  redact_financial_records: 'redact_financial_records_failed',
  redact_stored_documents: 'redact_stored_documents_failed',
  delete_customer_relations: 'delete_customer_relations_failed',
  delete_analytics_and_messaging: 'delete_analytics_and_messaging_failed',
  purge_projections: 'purge_projections_failed',
  delete_customer_record: 'delete_customer_record_failed',
};

export const UNKNOWN_ERASURE_ERROR_CODE = 'erasure_step_failed';

export class ErasureStepError extends Error {
  constructor(readonly step: ErasureStep, cause: unknown) {
    super(ERASURE_ERROR_CODES[step], { cause });
  }
}

/** Maps any workflow failure onto a stable error code that never carries personal data. */
export function erasureErrorCode(error: unknown): string {
  if (error instanceof ErasureStepError) return ERASURE_ERROR_CODES[error.step];
  return UNKNOWN_ERASURE_ERROR_CODE;
}
