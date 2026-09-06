import { withAdvisoryLock } from '../../../../packages/database/src/pool.js';
import { deleteMailpitMessageIds, deleteMailpitMessagesForRecipient } from '../../../../packages/notifications/src/mailpit.js';
import type { ErasureRequestRecord, SubjectContext } from '../../../../packages/privacy/src/types.js';

function emailAddresses(context: SubjectContext): string[] {
  return [...new Set(context.sensitiveValues.filter((value) => value.includes('@')))];
}

/** Cancels subject deliveries and removes the matching application-owned provider messages. */
export async function eraseNotificationProvider(request: ErasureRequestRecord): Promise<void> {
  const context = request.subject_context as SubjectContext;
  await withAdvisoryLock(`privacy:${request.merchant_id}:${request.customer_id}`, async (client) => {
    const deliveries = await client.query<{ provider_message_id: string }>(
      `SELECT provider_message_id FROM operations.email_deliveries
       WHERE merchant_id=$1 AND customer_id=$2 AND provider_message_id IS NOT NULL`,
      [request.merchant_id, request.customer_id],
    );
    await client.query(
      `UPDATE operations.email_deliveries SET customer_id=$3,destination='[redacted]',subject='[redacted]',
       text_body='[redacted]',html_body='[redacted]',provider_message_id=NULL,status='cancelled',
       cancelled_at=now(),last_error=NULL
       WHERE merchant_id=$1 AND customer_id=$2`,
      [request.merchant_id, request.customer_id, request.surrogate_id],
    );
    await deleteMailpitMessageIds(deliveries.rows.map((delivery) => delivery.provider_message_id));
    for (const destination of emailAddresses(context)) await deleteMailpitMessagesForRecipient(destination);
  });
}
