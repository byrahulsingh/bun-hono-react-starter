import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Column keys are written in snake_case and used as-is: the name in TypeScript
// is the name in the database, with no casing conversion in between.

/**
 * UUIDv7 primary key. Time-ordered, so inserts stay index-friendly like an
 * integer; not guessable in URLs (`/projects/42` would reveal volume); and
 * unique across client deployments, so exported data never collides.
 * Generated in the app, so it works on any Postgres version.
 */
export const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => Bun.randomUUIDv7());

/** Every time we store is a point in time, so always `timestamptz`. */
export const tstz = () => timestamp({ withTimezone: true });

export const createdAt = () => tstz().defaultNow().notNull();

/** For tables with a lifecycle: soft delete means `deleted_at` is set. */
export const timestamps = {
  created_at: createdAt(),
  updated_at: tstz()
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  deleted_at: tstz(),
};

/**
 * Lookup tables (statuses, scopes, modules): the readable key is the primary
 * key, so a referencing column stores `'active'` — readable without a join —
 * and the foreign key still rejects anything not in the list. Rows come from
 * a catalog in code, synced by the migrate job (db/catalog.ts).
 */
export const lookupColumns = () => ({
  key: text().primaryKey(),
  label: text().notNull(),
  sort_order: integer().notNull().default(0),
});
