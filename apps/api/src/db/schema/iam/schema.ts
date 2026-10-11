import { pgSchema } from 'drizzle-orm/pg-core';

/**
 * Postgres schema `iam`: who can sign in, and their sessions. Only the iam
 * module writes these tables, through the `iam_service` database role;
 * product code runs as `app_user`, which cannot read this schema at all.
 *
 * Tables in `public` may reference `iam.users`; nothing in `iam` references
 * `public`, so auth never depends on product tables.
 */
export const iam = pgSchema('iam');
