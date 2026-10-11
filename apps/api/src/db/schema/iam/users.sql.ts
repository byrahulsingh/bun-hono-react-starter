import { sql } from 'drizzle-orm';
import { boolean, check, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { id, timestamps, tstz } from '../column.helper';
import { userStatuses } from './lookups.sql';
import { iam } from './schema';

/** The login identity. The person inside the app is `public.profiles` (same id). */
export const users = iam.table(
  'users',
  {
    id: id(),
    /** Always stored lowercase; a CHECK enforces it so lookups never miss. */
    email: text().notNull(),
    /** Null when the account has no password (SSO only, phase 2). */
    password_hash: text(),
    email_confirmed_at: tstz(),
    status: text()
      .notNull()
      .default('active')
      .references(() => userStatuses.key),
    /** Calculated by Postgres, so it can never disagree with status / deleted_at. */
    is_active: boolean().generatedAlwaysAs(sql`status = 'active' and deleted_at is null`),
    last_login_at: tstz(),
    ...timestamps,
  },
  (t) => [
    // Only live rows count: a deleted user does not block the email.
    uniqueIndex('users_email_live').on(t.email).where(sql`deleted_at is null`),
    check('users_email_lowercase', sql`email = lower(email)`),
  ],
);

export type User = typeof users.$inferSelect;
