import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  POSTGRES_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: z.string().min(1),
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(8),
  OPENSEARCH_NODE: z.string().url(),
  CUSTOMER_SERVICE_URL: z.string().url(),
  PAYMENT_SERVICE_URL: z.string().url(),
  RECONCILIATION_SERVICE_URL: z.string().url(),
  PROCESSOR_URL: z.string().url(),
  PROCESSOR_WEBHOOK_URL: z.string().url().default('http://webhook-worker:3010/provider/webhooks'),
  PROCESSOR_WEBHOOK_SECRET: z.string().min(8),
  INTERNAL_SERVICE_TOKEN: z.string().min(8),
  MAILPIT_API_URL: z.string().url(),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  cached ??= schema.parse(process.env);
  return cached;
}
