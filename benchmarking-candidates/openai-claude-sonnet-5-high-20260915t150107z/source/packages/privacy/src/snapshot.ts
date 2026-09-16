import { erasedEmail, ERASED_NAME, erasedExternalReference, ERASED_STATUS } from './redaction.js';

export interface ErasedCustomerSnapshot {
  id: string;
  email: string;
  name: string;
  phone: null;
  external_reference: string;
  status: string;
}

/**
 * Builds the anonymized customer snapshot embedded in retained financial
 * records (payment intents, invoices) after erasure. Deterministic from the
 * customer id alone so every retry, and every record for the same customer,
 * converges on identical, non-identifying content.
 */
export function buildErasedCustomerSnapshot(customerId: string): ErasedCustomerSnapshot {
  return {
    id: customerId,
    email: erasedEmail(customerId),
    name: ERASED_NAME,
    phone: null,
    external_reference: erasedExternalReference(customerId),
    status: ERASED_STATUS,
  };
}
