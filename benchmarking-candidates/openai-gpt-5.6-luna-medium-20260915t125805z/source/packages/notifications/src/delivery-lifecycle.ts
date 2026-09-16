import type { PoolClient } from 'pg';
import { transaction } from '../../database/src/pool.js';
import { nextDeliveryDelaySeconds } from './delivery-policy.js';

export interface EmailDelivery {
  id: string;
  merchant_id: string;
  customer_id: string | null;
  destination: string;
  template: string;
  subject: string;
  text_body: string;
  html_body: string;
  message_key: string;
  attempts: number;
  max_attempts: number;
}

export async function recoverExpiredDeliveryLeases(): Promise<number> {
  const result = await transaction(async (client) => await client.query(
    `UPDATE operations.email_deliveries
     SET status='failed', available_at=now(), locked_by=NULL, locked_at=NULL, lease_expires_at=NULL,
         last_error=COALESCE(last_error, 'delivery_lease_expired')
     WHERE status='processing' AND lease_expires_at < now()`,
  ));
  return result.rowCount ?? 0;
}

export async function claimEmailDelivery(workerId: string, leaseSeconds = 60): Promise<EmailDelivery | undefined> {
  return await transaction(async (client) => {
    const result = await client.query<EmailDelivery>(
      `UPDATE operations.email_deliveries
       SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval,last_attempt_at=now(),last_error=NULL
       WHERE id=(SELECT id FROM operations.email_deliveries
         WHERE status IN ('pending','failed') AND attempts<max_attempts AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,customer_id,destination,template,subject,text_body,html_body,message_key,attempts,max_attempts`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  });
}

export async function markEmailDelivered(client: PoolClient, delivery: EmailDelivery, providerMessageId?: string): Promise<void> {
  await client.query(
    `UPDATE operations.email_deliveries
     SET status='delivered',provider_message_id=$2,provider_response=$3,delivered_at=now(),
         locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=NULL
     WHERE id=$1`,
    [delivery.id, providerMessageId ?? null, { messageId: providerMessageId ?? null }],
  );
  await client.query(
    `UPDATE operations.notifications
     SET status='delivered',attempts=$2,delivered_at=now(),updated_at=now(),last_error=NULL
     WHERE delivery_id=$1`,
    [delivery.id, delivery.attempts],
  );
}

export async function markEmailFailed(client: PoolClient, delivery: EmailDelivery, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  const exhausted = delivery.attempts >= delivery.max_attempts;
  await client.query(
    `UPDATE operations.email_deliveries
     SET status='failed',available_at=now()+($2 || ' seconds')::interval,last_error=$3,
         locked_by=NULL,locked_at=NULL,lease_expires_at=NULL
     WHERE id=$1`,
    [delivery.id, exhausted ? 0 : nextDeliveryDelaySeconds(delivery.attempts), message],
  );
  await client.query(
    `UPDATE operations.notifications
     SET status=$2,attempts=$3,updated_at=now(),last_error=$4
     WHERE delivery_id=$1`,
    [delivery.id, exhausted ? 'failed' : 'retrying', delivery.attempts, message],
  );
  if (exhausted) {
    await client.query(
      `INSERT INTO operations.dead_letters(source,source_id,event_type,payload,error)
       VALUES('email_delivery',$1,$2,$3,$4)`,
      [delivery.id, delivery.template, {
        merchantId: delivery.merchant_id, customerId: delivery.customer_id, destination: delivery.destination,
        template: delivery.template, messageKey: delivery.message_key,
      }, message],
    );
  }
}
