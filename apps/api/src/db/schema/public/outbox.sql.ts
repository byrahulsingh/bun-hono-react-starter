import { sql } from 'drizzle-orm';
import { bytea, index, integer, pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, id, tstz } from '../column.helper';

/**
 * Messages to send, written in the same transaction as the change that causes
 * them (an invitation, a password reset). A worker sends them afterwards, so
 * no request ever waits on SMTP, and a rolled-back change sends nothing.
 *
 * The payload is encrypted: emails can carry single-use links, which must not
 * sit readable in the database. It is cleared once the message is sent.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: id(),
    /** `email` for now. */
    kind: text().notNull(),
    /** In clear, unlike the payload, so a failed email can be listed for an admin. */
    recipient: text(),
    subject: text(),
    /** Encrypted JSON (libs/crypto); null after sending. */
    payload: bytea(),
    attempts: integer().notNull().default(0),
    /** Not before this time: the next try after a failure backs off. */
    run_after: tstz().notNull().defaultNow(),
    /** A worker holds the row until then; a crashed worker's rows free themselves. */
    locked_until: tstz(),
    sent_at: tstz(),
    /** Gave up after too many attempts. */
    failed_at: tstz(),
    last_error: text(),
    created_at: createdAt(),
  },
  (t) => [index('outbox_due').on(t.run_after).where(sql`sent_at is null and failed_at is null`)],
);
