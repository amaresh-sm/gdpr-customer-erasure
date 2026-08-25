import { pool, transaction } from '../../../../packages/database/src/pool.js';
import { containsSubjectValue, redactSubjectValue, sanitizeSubjectPayload } from '../../../../packages/privacy/src/redact.js';
import type { ErasureRequestRecord, SubjectContext } from '../../../../packages/privacy/src/types.js';

/** Sanitizes durable operational payloads so retries cannot restore the erased subject. */
export async function sanitizeOperationalRecords(request: ErasureRequestRecord): Promise<void> {
  const context = request.subject_context as SubjectContext;
  await transaction(async (client) => {
    const audits = await client.query<{ id: string; actor_id: string | null; target_id: string | null; metadata: unknown }>(
      `SELECT id,actor_id,target_id,metadata FROM platform.audit_logs WHERE merchant_id=$1 FOR UPDATE`,
      [request.merchant_id],
    );
    for (const row of audits.rows) {
      if (!containsSubjectValue({ actorId: row.actor_id, targetId: row.target_id, metadata: row.metadata }, context)) continue;
      await client.query(`UPDATE platform.audit_logs SET actor_id=$2,target_id=$3,metadata=$4 WHERE id=$1`, [
        row.id,
        row.actor_id === request.customer_id ? request.surrogate_id : redactSubjectValue(row.actor_id, context),
        row.target_id === request.customer_id ? request.surrogate_id : redactSubjectValue(row.target_id, context),
        sanitizeSubjectPayload(row.metadata, context),
      ]);
    }

    const outbox = await client.query<{ id: string; aggregate_id: string; aggregate_type: string; payload: unknown }>(
      `SELECT id,aggregate_id,aggregate_type,payload FROM operations.outbox_events WHERE merchant_id=$1 FOR UPDATE`,
      [request.merchant_id],
    );
    for (const row of outbox.rows) {
      if (!containsSubjectValue({ aggregateId: row.aggregate_id, payload: row.payload }, context)) continue;
      const aggregateId = row.aggregate_id === request.customer_id ? request.surrogate_id : row.aggregate_id;
      await client.query(`UPDATE operations.outbox_events SET aggregate_id=$2,payload=$3 WHERE id=$1`,
        [row.id, aggregateId, sanitizeSubjectPayload(row.payload, context)]);
    }

    const jobs = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.jobs WHERE merchant_id=$1 FOR UPDATE`, [request.merchant_id],
    );
    for (const row of jobs.rows) {
      if (containsSubjectValue(row.payload, context)) {
        await client.query(`UPDATE operations.jobs SET payload=$2 WHERE id=$1`,
          [row.id, sanitizeSubjectPayload(row.payload, context)]);
      }
    }

    const webhooks = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.provider_webhooks FOR UPDATE`,
    );
    for (const row of webhooks.rows) {
      if (containsSubjectValue(row.payload, context)) {
        await client.query(`UPDATE operations.provider_webhooks SET payload=$2 WHERE id=$1`,
          [row.id, sanitizeSubjectPayload(row.payload, context)]);
      }
    }

    const deadLetters = await client.query<{ id: string; payload: unknown; error: string }>(
      `SELECT id,payload,error FROM operations.dead_letters FOR UPDATE`,
    );
    for (const row of deadLetters.rows) {
      if (!containsSubjectValue(row, context)) continue;
      await client.query(`UPDATE operations.dead_letters SET payload=$2,error=$3 WHERE id=$1`,
        [row.id, sanitizeSubjectPayload(row.payload, context), redactSubjectValue(row.error, context)]);
    }

    const keys = await client.query<{ scope: string; key: string; response_body: unknown }>(
      `SELECT scope,key,response_body FROM operations.idempotency_keys WHERE merchant_id=$1 FOR UPDATE`,
      [request.merchant_id],
    );
    for (const row of keys.rows) {
      if (containsSubjectValue(row.response_body, context)) {
        await client.query(
          `UPDATE operations.idempotency_keys SET response_body=$4
           WHERE merchant_id=$1 AND scope=$2 AND key=$3`,
          [request.merchant_id, row.scope, row.key, sanitizeSubjectPayload(row.response_body, context)],
        );
      }
    }

    const analytics = await client.query<{ id: string; customer_id: string | null; anonymous_id: string | null; email: string | null; properties: unknown }>(
      `SELECT id,customer_id,anonymous_id,email,properties FROM operations.analytics_events
       WHERE merchant_id=$1 FOR UPDATE`, [request.merchant_id],
    );
    for (const row of analytics.rows) {
      if (!containsSubjectValue({ customerId: row.customer_id, properties: row.properties }, context)) continue;
      await client.query(
        `UPDATE operations.analytics_events SET customer_id=NULL,email=NULL,anonymous_id=$2,properties=$3 WHERE id=$1`,
        [row.id, `anon_${request.surrogate_id}`, sanitizeSubjectPayload(row.properties, context)],
      );
    }

    await client.query(
      `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [request.merchant_id, request.customer_id],
    );
    await client.query(
      `DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`,
      [request.merchant_id, request.customer_id],
    );

    const manifests = await client.query<{ id: string; metadata: unknown }>(
      `SELECT id,metadata FROM operations.document_manifests
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`, [request.merchant_id, request.customer_id],
    );
    for (const row of manifests.rows) {
      await client.query(
        `UPDATE operations.document_manifests SET customer_id=$2,metadata=$3 WHERE id=$1`,
        [row.id, request.surrogate_id, sanitizeSubjectPayload(row.metadata, context)],
      );
    }
  });

  // A second pass catches a notification whose transaction committed while the first pass ran.
  await pool.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`,
    [request.merchant_id, request.customer_id]);
}
