import { advisoryLock, transaction } from '../../../../packages/database/src/pool.js';
import { redactSubjectValue } from '../../../../packages/privacy/src/redact.js';
import type { ErasureRequestRecord, SubjectContext } from '../../../../packages/privacy/src/types.js';

/** Removes direct customer records while preserving unrelated participants in shared support data. */
export async function eraseCustomerRecords(request: ErasureRequestRecord): Promise<void> {
  const context = request.subject_context as SubjectContext;
  await transaction(async (client) => {
    await advisoryLock(client, `privacy:${request.merchant_id}:${request.customer_id}`);
    const tickets = await client.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM customers.support_participants WHERE customer_id=$1 FOR UPDATE`, [request.customer_id],
    );
    for (const { ticket_id: ticketId } of tickets.rows) {
      const ticket = await client.query<{ subject: string }>(
        `SELECT subject FROM customers.support_tickets WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
        [request.merchant_id, ticketId],
      );
      if (ticket.rows[0]) {
        await client.query(`UPDATE customers.support_tickets SET subject=$2 WHERE id=$1`,
          [ticketId, redactSubjectValue(ticket.rows[0].subject, context)]);
      }
      const messages = await client.query<{ id: string; author_type: string; author_id: string | null; body: string; attachments: unknown }>(
        `SELECT id,author_type,author_id,body,attachments FROM customers.support_messages
         WHERE merchant_id=$1 AND ticket_id=$2 FOR UPDATE`, [request.merchant_id, ticketId],
      );
      for (const message of messages.rows) {
        const authoredBySubject = message.author_type === 'customer' && message.author_id === request.customer_id;
        await client.query(
          `UPDATE customers.support_messages SET author_id=$2,body=$3,attachments=$4 WHERE id=$1`,
          [message.id,
            authoredBySubject ? request.surrogate_id : message.author_id,
            authoredBySubject ? '[redacted]' : redactSubjectValue(message.body, context),
            authoredBySubject ? [] : redactSubjectValue(message.attachments, context)],
        );
      }
    }
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [request.customer_id]);
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`,
      [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`,
      [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`,
      [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`,
      [request.merchant_id, request.customer_id]);
    await client.query(`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
      [request.merchant_id, request.customer_id]);
  });
}
