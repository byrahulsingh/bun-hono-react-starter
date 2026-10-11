import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { timestamps } from '../column.helper';
import { users } from '../iam/users.sql';
import { roles } from './roles.sql';

/** The person inside the app. Same id as their `iam.users` login. */
export const profiles = pgTable('profiles', {
  id: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  /** owner / admin, or a custom org role. Null: access only through tenant memberships. */
  org_role_id: uuid().references((): AnyPgColumn => roles.id),
  preferences: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
});

export type Profile = typeof profiles.$inferSelect;
