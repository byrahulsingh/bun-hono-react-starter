import { sql } from 'drizzle-orm';
import { bytea, check, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, tstz } from '../column.helper';
import { iam } from './schema';
import { users } from './users.sql';

/**
 * A new sign-in email waiting for its confirmation link to be opened. One per
 * person: asking again replaces it. The email changes only when the link,
 * sent to the new address, is opened.
 */
export const emailChanges = iam.table(
  'email_changes',
  {
    user_id: uuid()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    new_email: text().notNull(),
    token_hash: bytea().notNull(),
    expires_at: tstz().notNull(),
    created_at: createdAt(),
  },
  (t) => [
    uniqueIndex('email_changes_hash').on(t.token_hash),
    check('email_changes_new_email_lowercase', sql`${t.new_email} = lower(${t.new_email})`),
  ],
);
