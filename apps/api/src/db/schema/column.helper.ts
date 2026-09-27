import { timestamp, uuid } from 'drizzle-orm/pg-core';

// Column keys are written in snake_case and used as-is: the name in TypeScript
// is the name in the database, with no casing conversion in between.

/**
 * UUIDv7 primary key. Time-ordered, so inserts stay index-friendly like an
 * integer; not guessable in URLs (`/orders/42` would reveal volume); and
 * unique across client deployments, so exported data never collides.
 * Generated in the app, so it works on any Postgres version.
 */
export const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => Bun.randomUUIDv7());

export const timestamps = {
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp({ withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  deleted_at: timestamp({ withTimezone: true }),
};
