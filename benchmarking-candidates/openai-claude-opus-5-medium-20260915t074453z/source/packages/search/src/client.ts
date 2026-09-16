import { Client } from '@opensearch-project/opensearch';
import { config } from '../../config/src/index.js';

export const searchClient = new Client({ node: config().OPENSEARCH_NODE });
export const CUSTOMER_INDEX = 'payflow-customers-v1';

export function customerDocumentId(merchantId: string, customerId: string): string {
  return `${merchantId}:${customerId}`;
}

/** Removes a customer from the search index, tolerating an index or document that is already gone. */
export async function deleteCustomerDocument(merchantId: string, customerId: string): Promise<void> {
  try {
    await searchClient.delete({
      index: CUSTOMER_INDEX,
      id: customerDocumentId(merchantId, customerId),
      refresh: true,
    });
  } catch (error) {
    const status = (error as { meta?: { statusCode?: number } }).meta?.statusCode;
    if (status !== 404) throw error;
  }
}
