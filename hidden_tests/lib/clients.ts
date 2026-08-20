import { createHash } from 'node:crypto';
import { Client as SearchClient } from '@opensearch-project/opensearch';
import { Redis } from 'ioredis';
import { Kafka, logLevel } from 'kafkajs';
import { Client as MinioClient } from 'minio';
import pg from 'pg';

export const settings = {
  gateway: process.env.GATEWAY_URL ?? 'http://api-gateway:3000',
  postgres: process.env.POSTGRES_URL ?? 'postgres://payflow:payflow@postgres:5432/payflow',
  redis: process.env.REDIS_URL ?? 'redis://redis:6379',
  search: process.env.OPENSEARCH_NODE ?? 'http://opensearch:9200',
  kafka: (process.env.KAFKA_BROKERS ?? 'redpanda:9092').split(','),
  minioHost: process.env.MINIO_ENDPOINT ?? 'minio',
  minioPort: Number(process.env.MINIO_PORT ?? 9000),
  minioAccess: process.env.MINIO_ACCESS_KEY ?? 'payflow',
  minioSecret: process.env.MINIO_SECRET_KEY ?? 'payflow-secret',
};

export const pool = new pg.Pool({ connectionString: settings.postgres, max: 10 });
export const redis = new Redis(settings.redis);
export const search = new SearchClient({ node: settings.search });
export const minio = new MinioClient({ endPoint: settings.minioHost, port: settings.minioPort,
  useSSL: false, accessKey: settings.minioAccess, secretKey: settings.minioSecret });
export const kafka = new Kafka({ clientId: 'payflow-hidden-verifier', brokers: settings.kafka, logLevel: logLevel.NOTHING });
export const DOCUMENT_BUCKET = 'payflow-documents';
export const CUSTOMER_INDEX = 'payflow-customers-v1';

/** Produces a stable UUID from a fixture label without using application code. */
export function fixtureUuid(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

export async function closeClients(): Promise<void> {
  await Promise.all([pool.end(), redis.quit()]);
}
