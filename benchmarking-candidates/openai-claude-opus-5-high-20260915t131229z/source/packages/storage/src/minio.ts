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
