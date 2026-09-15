import type { eventEnvelopeSchema } from '../../../packages/contracts/src/events.js';
import { transaction } from '../../../packages/database/src/pool.js';

type DomainEvent = ReturnType<typeof eventEnvelopeSchema.parse>;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export async function recordEmailDelivery(
  event: DomainEvent,
  template: string,
  destination: string,
  rendered: RenderedEmail,
): Promise<boolean> {
  return await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO operations.inbox_events(consumer,event_id,event_type,status)
       VALUES('notification-worker',$1,$2,'processing') ON CONFLICT DO NOTHING`,
      [event.eventId, event.eventType],
    );
    if (!inserted.rowCount) return false;

    const customerId = typeof event.payload.customerId === 'string' ? event.payload.customerId : null;
    if (customerId) {
      await client.query(
        `INSERT INTO operations.notification_preferences(merchant_id,customer_id,channel,destination)
         VALUES($1,$2,'email',$3) ON CONFLICT(merchant_id,customer_id,channel)
         DO UPDATE SET destination=EXCLUDED.destination,updated_at=now()`,
        [event.merchantId, customerId, destination],
      );
    }
    const delivery = await client.query<{ id: string }>(
      `INSERT INTO operations.email_deliveries
       (merchant_id,customer_id,destination,template,subject,text_body,html_body)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [event.merchantId, customerId, destination, template, rendered.subject, rendered.text, rendered.html],
    );
    await client.query(
      `INSERT INTO operations.notifications
       (merchant_id,customer_id,channel,destination,template,payload,delivery_id,status,attempts)
       VALUES($1,$2,'email',$3,$4,$5,$6,'queued',0)`,
      [event.merchantId, customerId, destination, template, event.payload, delivery.rows[0]!.id],
    );
    await client.query(
      `UPDATE operations.inbox_events SET status='processed',processed_at=now()
       WHERE consumer='notification-worker' AND event_id=$1`,
      [event.eventId],
    );
    return true;
  });
}
