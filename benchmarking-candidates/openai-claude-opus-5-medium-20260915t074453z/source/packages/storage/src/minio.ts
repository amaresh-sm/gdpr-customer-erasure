import { createHash } from 'node:crypto';
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

export async function listObjectKeys(prefix: string): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    const keys: string[] = [];
    const stream = objectStore.listObjectsV2(DOCUMENT_BUCKET, prefix, true);
    stream.on('data', (item) => { if (item.name) keys.push(item.name); });
    stream.on('error', reject);
    stream.on('end', () => resolve(keys));
  });
}

export async function readObject(objectKey: string): Promise<string> {
  const stream = await objectStore.getObject(DOCUMENT_BUCKET, objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Overwrites a stored document in place, returning the checksum of the new content. */
export async function replaceObject(objectKey: string, body: string): Promise<string> {
  await objectStore.putObject(DOCUMENT_BUCKET, objectKey, body, Buffer.byteLength(body), {
    'Content-Type': 'application/json',
  });
  return createHash('sha256').update(body).digest('hex');
}

export async function removeObject(objectKey: string): Promise<void> {
  await objectStore.removeObject(DOCUMENT_BUCKET, objectKey);
}
