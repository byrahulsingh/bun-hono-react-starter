import type { Tx } from '#/db/db';
import { outbox } from '#/db/schema';
import { encrypt } from '#/libs/crypto';

import type { EmailContent } from './email-layout';

export const OUTBOX_PAYLOAD_CONTEXT = 'outbox.payload';

/**
 * Queues an email in the caller's transaction. It is sent after commit by the
 * outbox worker, in the branded layout; if the transaction rolls back, it
 * never existed. Recipient and subject are kept readable (for the list of
 * failed emails); the body is encrypted, since it can carry a single-use link.
 */
export async function enqueueEmail(tx: Tx, content: EmailContent): Promise<void> {
  const payload = await encrypt(JSON.stringify(content), OUTBOX_PAYLOAD_CONTEXT);
  await tx.insert(outbox).values({ kind: 'email', recipient: content.to, subject: content.subject, payload: Buffer.from(payload) });
}
