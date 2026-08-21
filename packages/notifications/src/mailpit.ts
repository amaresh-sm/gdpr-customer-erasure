import { config } from '../../config/src/index.js';

export interface OutboundEmail {
  messageKey: string;
  destination: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}

interface MailpitMessageSummary {
  ID?: string;
  Id?: string;
  id?: string;
}

function messageId(value: MailpitMessageSummary): string | undefined {
  return value.ID ?? value.Id ?? value.id;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`${config().MAILPIT_API_URL}${path}`, init);
}

/** Sends a captured product email through the local provider API. */
export async function sendMailpitEmail(email: OutboundEmail): Promise<string | undefined> {
  const response = await request('/api/v1/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      From: { Email: 'receipts@payflow.local', Name: 'PayFlow' },
      To: [{ Email: email.destination }],
      Subject: email.subject,
      Text: email.textBody,
      HTML: email.htmlBody,
    }),
  });
  if (!response.ok) throw new Error(`mailpit_send_failed:${response.status}`);
  const body = await response.json() as MailpitMessageSummary;
  return messageId(body);
}

async function matchingMessageIds(destination: string): Promise<string[]> {
  const response = await request(`/api/v1/search?query=${encodeURIComponent(`to:${destination}`)}`);
  if (!response.ok) throw new Error(`mailpit_search_failed:${response.status}`);
  const body = await response.json() as { messages?: MailpitMessageSummary[] };
  return [...new Set((body.messages ?? []).map(messageId).filter((id): id is string => Boolean(id)))];
}

/** Returns whether the provider still has a message for the supplied recipient. */
export async function mailpitHasMessagesForRecipient(destination: string): Promise<boolean> {
  return (await matchingMessageIds(destination)).length > 0;
}

/** Removes captured provider messages addressed to a deleted subject. */
export async function deleteMailpitMessagesForRecipient(destination: string): Promise<void> {
  const ids = await matchingMessageIds(destination);
  if (ids.length === 0) return;
  const response = await request('/api/v1/messages', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: ids }),
  });
  if (!response.ok) throw new Error(`mailpit_delete_failed:${response.status}`);
}
