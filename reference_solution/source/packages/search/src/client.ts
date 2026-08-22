import { Client } from '@opensearch-project/opensearch';
import { config } from '../../config/src/index.js';

export const searchClient = new Client({ node: config().OPENSEARCH_NODE });
export const CUSTOMER_INDEX = 'payflow-customers-v1';
