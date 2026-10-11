import { sql } from 'drizzle-orm';
import { bytea, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id, tstz } from '../column.helper';
import { tokenTypes } from './lookups.sql';
import { iam } from './schema';
import { users } from './users.sql';

/**
 * Single-use links we email or print: first-owner setup, password reset.
 * Only the keyed hash is stored; the raw token exists in the link alone.
 */
export const oneTimeTokens = iam.table(
  'one_time_tokens',
  {
    id: id(),
    /** Null for the setup token: there is no user yet. */
    user_id: uuid().references(() => users.id, { onDelete: 'cascade' }),
    type: text()
      .notNull()
      .references(() => tokenTypes.key),
    token_hash: bytea().notNull(),
    expires_at: tstz().notNull(),
    consumed_at: tstz(),
    created_at: createdAt(),
  },
  (t) => [
    uniqueIndex('one_time_tokens_hash').on(t.token_hash),
    // One live token per user and type: asking again replaces the old one.
    uniqueIndex('one_time_tokens_one_live').on(t.user_id, t.type).where(sql`consumed_at is null`),
  ],
);
