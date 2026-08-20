import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pool } from '../../../../packages/database/src/pool.js';
import { containsSubjectValue, erasedCustomerBlock, redactSubjectValue } from '../../../../packages/privacy/src/redact.js';
import type { ErasureRequestRecord, SubjectContext } from '../../../../packages/privacy/src/types.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../../packages/storage/src/minio.js';

async function readObject(key: string): Promise<Buffer | undefined> {
  try {
    const stream = await objectStore.getObject(DOCUMENT_BUCKET, key) as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'NoSuchKey' || code === 'NotFound') return undefined;
    throw error;
  }
}

/** Deletes source imports and rewrites retained financial documents without customer identity. */
export async function sanitizeObjectStorage(request: ErasureRequestRecord): Promise<void> {
  const context = request.subject_context as SubjectContext;
  await ensureBucket();
  const manifests = await pool.query<{ id: string; object_key: string; document_type: string }>(
    `SELECT id,object_key,document_type FROM operations.document_manifests
     WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id],
  );
  for (const manifest of manifests.rows) {
    const body = await readObject(manifest.object_key);
    if (!body) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch { parsed = body.toString('utf8'); }
    const redacted = redactSubjectValue(parsed, context);
    if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
      const document = redacted as Record<string, unknown>;
      if ('customer' in document) document.customer = erasedCustomerBlock(context);
    }
    const output = Buffer.from(typeof redacted === 'string' ? redacted : JSON.stringify(redacted));
    await objectStore.putObject(DOCUMENT_BUCKET, manifest.object_key, output, output.length,
      { 'Content-Type': 'application/json' });
    await pool.query(`UPDATE operations.document_manifests SET checksum=$2 WHERE id=$1`,
      [manifest.id, createHash('sha256').update(output).digest('hex')]);
  }

  const imports = await pool.query<{ id: string; object_key: string }>(
    `SELECT id,object_key FROM customers.customer_imports WHERE merchant_id=$1`, [request.merchant_id],
  );
  for (const item of imports.rows) {
    const body = await readObject(item.object_key);
    if (!body || !containsSubjectValue(body.toString('utf8'), context)) continue;
    await objectStore.removeObject(DOCUMENT_BUCKET, item.object_key);
    await pool.query(`DELETE FROM operations.document_manifests WHERE object_key=$1`, [item.object_key]);
    await pool.query(`DELETE FROM customers.customer_imports WHERE id=$1`, [item.id]);
  }
}
