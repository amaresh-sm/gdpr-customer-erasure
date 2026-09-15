import { Client } from 'minio';
import { config } from '../../config/src/index.js';

const settings = config();
export const objectStore = new Client({
  endPoint: settings.MINIO_ENDPOINT,
  port: settings.MINIO_PORT,
  useSSL: false,
  accessKey: settings.MINIO_ACCESS_KEY,
  secretKey: settings.MINIO_SECRET_KEY,
});
export const DOCUMENT_BUCKET = 'payflow-documents';

export async function ensureBucket(): Promise<void> {
  if (!(await objectStore.bucketExists(DOCUMENT_BUCKET))) await objectStore.makeBucket(DOCUMENT_BUCKET);
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads a stored JSON document, or `undefined` if the object no longer exists. */
export async function getJsonObject(bucket: string, objectKey: string): Promise<Record<string, unknown> | undefined> {
  try {
    const stream = await objectStore.getObject(bucket, objectKey);
    return JSON.parse(await streamToString(stream)) as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: string }).code === 'NoSuchKey') return undefined;
    throw error;
  }
}

/** Overwrites a stored JSON document in place, preserving its object key. */
export async function putJsonObject(bucket: string, objectKey: string, document: Record<string, unknown>): Promise<string> {
  const body = JSON.stringify(document);
  await objectStore.putObject(bucket, objectKey, body, Buffer.byteLength(body), { 'Content-Type': 'application/json' });
  return body;
}
