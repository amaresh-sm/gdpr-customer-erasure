import { createHash } from 'node:crypto';
import type pg from 'pg';
import { pool } from '../../database/src/pool.js';
import {
  deleteCachedProjections,
  deleteCapturedEmails,
  deleteSearchDocuments,
  deleteStoredDocument,
  readStoredDocument,
  writeStoredDocument,
} from './external.js';
import {
  ERASURE_STEPS,
  ErasureStepError,
  PII_ATTRIBUTES,
  redactDocument,
  redactedCustomerSnapshot,
  REDACTED_TEXT,
  type ErasureStep,
} from './redaction.js';
import { completedSteps, withStep, type ErasureRequestRow } from './repository.js';

interface ErasureTarget {
  requestId: string;
  merchantId: string;
  customerId: string;
}

type StepHandler = (target: ErasureTarget) => Promise<void>;

/**
 * Marks the subject as erased. The tombstone is written first so that in-flight and
 * replayed work is rejected while the remaining steps run, and it outlives the request
 * so later deliveries can never recreate the subject.
 */
async function blockNewProcessing(target: ErasureTarget): Promise<void> {
  await withStep(target.requestId, 'block_new_processing', async (client) => {
    await client.query(
      `INSERT INTO privacy.erased_customers(merchant_id,customer_id,request_id)
       VALUES($1,$2,$3) ON CONFLICT(merchant_id,customer_id) DO NOTHING`,
      [target.merchantId, target.customerId, target.requestId],
    );
  });
}

async function subjectDestinations(target: ErasureTarget): Promise<string[]> {
  const result = await pool.query<{ destination: string }>(
    `SELECT DISTINCT destination FROM (
       SELECT email destination FROM customers.customers WHERE merchant_id=$1 AND id=$2
       UNION SELECT value FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2 AND kind='email'
       UNION SELECT destination FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2
       UNION SELECT destination FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2
       UNION SELECT destination FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2
       UNION SELECT customer_snapshot->>'email' FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
       UNION SELECT billing_snapshot->>'email' FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2
       UNION SELECT r.customer_email FROM payments.refunds r JOIN payments.payment_intents p ON p.id=r.payment_intent_id
         WHERE p.merchant_id=$1 AND p.customer_id=$2
     ) addresses WHERE destination IS NOT NULL`,
    [target.merchantId, target.customerId],
  );
  return result.rows.map((row) => row.destination);
}

/**
 * Purges outbound mail already handed to the provider. It runs before the delivery records are
 * deleted, because their destinations are the only way to find those messages; nothing can be
 * sent in the meantime, because the tombstone written by the previous step stops the mail queue
 * from claiming work for the subject.
 */
async function purgeCapturedMail(target: ErasureTarget): Promise<void> {
  const destinations = await subjectDestinations(target);
  await deleteCapturedEmails(destinations);
  await withStep(target.requestId, 'purge_captured_mail', async () => undefined);
}

/**
 * Removes queued and sent messaging records and strips personal data from work that has
 * not been delivered yet, so nothing still in flight can publish it again.
 */
async function stopPendingDelivery(target: ErasureTarget): Promise<void> {
  await withStep(target.requestId, 'stop_pending_delivery', async (client) => {
    await client.query(
      `DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`,
      [target.merchantId, target.customerId],
    );
    await client.query(
      `DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`,
      [target.merchantId, target.customerId],
    );
    await client.query(
      `UPDATE operations.outbox_events
       SET payload=(payload - $3::text[]) || jsonb_build_object('redacted',true)
       WHERE merchant_id=$1
         AND ((aggregate_type='customer' AND aggregate_id=$2) OR payload->>'customerId'=$2::text)`,
      [target.merchantId, target.customerId, PII_ATTRIBUTES],
    );
    await client.query(
      `UPDATE operations.jobs
       SET payload=(payload - $3::text[]) ||
         CASE WHEN payload ? 'customerSnapshot'
           THEN jsonb_build_object('customerSnapshot',$4::jsonb) ELSE '{}'::jsonb END
       WHERE merchant_id=$1 AND payload->>'customerId'=$2::text`,
      [
        target.merchantId,
        target.customerId,
        PII_ATTRIBUTES,
        JSON.stringify(redactedCustomerSnapshot(target.customerId)),
      ],
    );
    await client.query(
      `UPDATE operations.dead_letters
       SET payload=(payload - $2::text[]) || jsonb_build_object('redacted',true)
       WHERE payload->>'customerId'=$1::text`,
      [target.customerId, PII_ATTRIBUTES],
    );
  });
}

/**
 * Keeps payments, refunds, invoices and their ledger trail financially intact while
 * removing every attribute that identifies the erased subject.
 */
async function redactFinancialRecords(target: ErasureTarget): Promise<void> {
  const snapshot = JSON.stringify(redactedCustomerSnapshot(target.customerId));
  await withStep(target.requestId, 'redact_financial_records', async (client) => {
    await client.query(
      `UPDATE payments.payment_intents SET customer_snapshot=$3::jsonb,description=NULL,updated_at=now()
       WHERE merchant_id=$1 AND customer_id=$2`,
      [target.merchantId, target.customerId, snapshot],
    );
    await client.query(
      `UPDATE payments.payment_attempts a
       SET request_payload=a.request_payload - $3::text[],
           response_payload=CASE WHEN a.response_payload IS NULL THEN NULL
             ELSE a.response_payload - $3::text[] END
       FROM payments.payment_intents p
       WHERE p.id=a.payment_intent_id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [target.merchantId, target.customerId, PII_ATTRIBUTES],
    );
    await client.query(
      `UPDATE payments.refunds r SET customer_email=NULL
       FROM payments.payment_intents p
       WHERE p.id=r.payment_intent_id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [target.merchantId, target.customerId],
    );
    await client.query(
      `UPDATE payments.disputes d SET evidence=d.evidence - $3::text[]
       FROM payments.payment_intents p
       WHERE p.id=d.payment_intent_id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [target.merchantId, target.customerId, PII_ATTRIBUTES],
    );
    await client.query(
      `UPDATE payments.invoices SET billing_snapshot=$3::jsonb
       WHERE merchant_id=$1 AND customer_id=$2`,
      [target.merchantId, target.customerId, snapshot],
    );
    // Line descriptions are merchant-written text that routinely names the subject; the
    // quantities and amounts that carry the financial meaning are left untouched.
    await client.query(
      `UPDATE payments.invoice_lines l SET description=$3
       FROM payments.invoices i
       WHERE i.id=l.invoice_id AND i.merchant_id=$1 AND i.customer_id=$2`,
      [target.merchantId, target.customerId, REDACTED_TEXT],
    );
    await client.query(
      `UPDATE payments.reconciliation_items i SET detail=i.detail - $3::text[]
       FROM payments.reconciliation_runs r, payments.payment_intents p
       WHERE i.run_id=r.id AND r.merchant_id=$1 AND p.merchant_id=$1 AND p.customer_id=$2
         AND i.reference_id=p.id::text`,
      [target.merchantId, target.customerId, PII_ATTRIBUTES],
    );
  });
}

/** Rewrites a retained document in place with every identifying attribute redacted. */
async function redactDocumentObject(target: ErasureTarget, objectKey: string): Promise<void> {
  const body = await readStoredDocument(objectKey);
  if (!body) return;
  const redacted = JSON.stringify(redactDocument(JSON.parse(body), target.customerId));
  await writeStoredDocument(objectKey, redacted);
  await pool.query(
    `UPDATE operations.document_manifests
     SET checksum=$2,metadata=metadata || jsonb_build_object('redacted',true)
     WHERE object_key=$1`,
    [objectKey, createHash('sha256').update(redacted).digest('hex')],
  );
}

/** Deletes an import artifact together with the manifest that catalogues it. */
async function deleteImportArtifact(target: ErasureTarget, importId: string, objectKey: string): Promise<void> {
  await deleteStoredDocument(objectKey);
  await pool.query(`DELETE FROM operations.document_manifests WHERE object_key=$1`, [objectKey]);
  await pool.query(
    `DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND id=$2`,
    [target.merchantId, importId],
  );
}

/**
 * An import artifact that describes only the subject is deleted outright. One that also covers
 * other customers is rewritten instead, so a shared file keeps serving the people still in it.
 */
async function eraseImportArtifact(
  target: ErasureTarget,
  importId: string,
  objectKey: string,
  needles: string[],
): Promise<void> {
  const body = await readStoredDocument(objectKey);
  if (!body) return;
  if (!needles.some((needle) => needle.length > 0 && body.includes(needle))) return;
  const parsed = JSON.parse(body) as { customerId?: unknown };
  if (parsed.customerId === target.customerId) {
    await deleteImportArtifact(target, importId, objectKey);
    return;
  }
  await redactDocumentObject(target, objectKey);
}

/**
 * Object storage holds receipts and invoices PayFlow retains, plus import artifacts it
 * does not. Retained documents are rewritten without identifying data; import artifacts
 * are deleted with their manifests so storage and catalogue stay consistent.
 */
async function redactStoredDocuments(target: ErasureTarget): Promise<void> {
  const retained = await pool.query<{ object_key: string }>(
    `SELECT object_key FROM operations.document_manifests
     WHERE merchant_id=$1 AND customer_id=$2 AND document_type IN ('receipt','invoice')`,
    [target.merchantId, target.customerId],
  );
  for (const document of retained.rows) await redactDocumentObject(target, document.object_key);

  const subject = await pool.query<{ email: string; external_reference: string }>(
    `SELECT email,external_reference FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
    [target.merchantId, target.customerId],
  );
  const needles = [
    target.customerId,
    ...(subject.rows[0] ? [subject.rows[0].email, subject.rows[0].external_reference] : []),
  ];
  const imports = await pool.query<{ id: string; object_key: string }>(
    `SELECT id,object_key FROM customers.customer_imports WHERE merchant_id=$1`,
    [target.merchantId],
  );
  for (const artifact of imports.rows) {
    await eraseImportArtifact(target, artifact.id, artifact.object_key, needles);
  }
  await withStep(target.requestId, 'redact_stored_documents', async () => undefined);
}

/**
 * Redacts the subject's contact details where someone else quoted them in a conversation that
 * has to stay readable for its remaining participants.
 */
async function redactSupportMentions(client: pg.PoolClient, target: ErasureTarget): Promise<void> {
  const mentions = await client.query<{ mention: string }>(
    `SELECT DISTINCT mention FROM (
       SELECT email mention FROM customers.customers WHERE merchant_id=$1 AND id=$2
       UNION SELECT phone FROM customers.customers WHERE merchant_id=$1 AND id=$2
       UNION SELECT value FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2
     ) values WHERE mention IS NOT NULL AND length(mention)>0`,
    [target.merchantId, target.customerId],
  );
  for (const { mention } of mentions.rows) {
    await client.query(
      `UPDATE customers.support_messages SET body=replace(body,$2,$3)
       WHERE merchant_id=$1 AND position($2 in body)>0`,
      [target.merchantId, mention, REDACTED_TEXT],
    );
  }
}

/**
 * Deletes the profile data attached to the customer. Support conversations are shared, so
 * only the subject's participation and authored messages go; a thread is removed only once
 * nobody is left who needs it.
 */
async function deleteCustomerRelations(target: ErasureTarget): Promise<void> {
  await withStep(target.requestId, 'delete_customer_relations', async (client) => {
    const parameters = [target.merchantId, target.customerId];
    const tickets = await client.query<{ ticket_id: string }>(
      `SELECT p.ticket_id FROM customers.support_participants p
       JOIN customers.support_tickets t ON t.id=p.ticket_id
       WHERE t.merchant_id=$1 AND p.customer_id=$2`,
      parameters,
    );
    await client.query(
      `DELETE FROM customers.support_messages
       WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
      parameters,
    );
    await redactSupportMentions(client, target);
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [target.customerId]);
    for (const { ticket_id } of tickets.rows) {
      const remaining = await client.query(
        `SELECT 1 FROM customers.support_participants WHERE ticket_id=$1 LIMIT 1`,
        [ticket_id],
      );
      if (remaining.rowCount) continue;
      await client.query(`DELETE FROM customers.support_messages WHERE ticket_id=$1`, [ticket_id]);
      await client.query(`DELETE FROM customers.support_tickets WHERE id=$1 AND merchant_id=$2`, [
        ticket_id,
        target.merchantId,
      ]);
    }
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, parameters);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, parameters);
    await client.query(
      `DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`,
      parameters,
    );
    await client.query(
      `DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`,
      parameters,
    );
    await client.query(
      `DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      parameters,
    );
  });
}

/** Clears behavioural, messaging-preference and audit trails that describe the subject. */
async function deleteAnalyticsAndMessaging(target: ErasureTarget): Promise<void> {
  await withStep(target.requestId, 'delete_analytics_and_messaging', async (client) => {
    await client.query(
      `DELETE FROM operations.analytics_events
       WHERE merchant_id=$1 AND (customer_id=$2 OR anonymous_id='anon_' || $2::text
         OR properties->>'customerId'=$2::text)`,
      [target.merchantId, target.customerId],
    );
    await client.query(
      `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [target.merchantId, target.customerId],
    );
    await client.query(
      `UPDATE platform.audit_logs SET metadata=jsonb_build_object('redacted',true)
       WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2::text
         AND action NOT LIKE 'privacy.%'`,
      [target.merchantId, target.customerId],
    );
  });
}

/** Removes the read models served from the cache and the search index. */
async function purgeProjections(target: ErasureTarget): Promise<void> {
  await deleteCachedProjections(target.merchantId, target.customerId);
  await deleteSearchDocuments(target.merchantId, target.customerId);
  await withStep(target.requestId, 'purge_projections', async () => undefined);
}

/** Deletes the customer record itself; only the tombstone remains. */
async function deleteCustomerRecord(target: ErasureTarget): Promise<void> {
  await withStep(target.requestId, 'delete_customer_record', async (client) => {
    await client.query(`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [
      target.merchantId,
      target.customerId,
    ]);
  });
}

const HANDLERS: Readonly<Record<ErasureStep, StepHandler>> = {
  block_new_processing: blockNewProcessing,
  purge_captured_mail: purgeCapturedMail,
  stop_pending_delivery: stopPendingDelivery,
  redact_financial_records: redactFinancialRecords,
  redact_stored_documents: redactStoredDocuments,
  delete_customer_relations: deleteCustomerRelations,
  delete_analytics_and_messaging: deleteAnalyticsAndMessaging,
  purge_projections: purgeProjections,
  delete_customer_record: deleteCustomerRecord,
};

/**
 * Runs the outstanding steps for a request. Steps are ordered, individually idempotent
 * and recorded once finished, so a retry after a crash resumes instead of repeating
 * destructive work.
 */
export async function runErasureRequest(request: ErasureRequestRow): Promise<void> {
  const target: ErasureTarget = {
    requestId: request.id,
    merchantId: request.merchant_id,
    customerId: request.customer_id,
  };
  const finished = await completedSteps(request.id);
  for (const step of ERASURE_STEPS) {
    if (finished.has(step)) continue;
    try {
      await HANDLERS[step](target);
    } catch (error) {
      throw new ErasureStepError(step, error);
    }
  }
}
