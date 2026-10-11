import { pgRole } from 'drizzle-orm/pg-core';

/**
 * The two database roles every query runs as (`set local role`, see db.ts).
 * Neither can log in; the app's login role switches into them per transaction.
 *
 *   app_user     product tables in `public`; row-level security applies to it.
 *                No access to schema `iam` at all.
 *   iam_service  schema `iam`, plus the few `public` tables auth must write
 *                (access.ts lists them).
 *
 * `.existing()`: drizzle-kit must not emit CREATE ROLE. Roles belong to the
 * whole Postgres server, not one database, so a plain CREATE ROLE fails as
 * soon as a second database (tests, a second install) is migrated.
 * access.ts creates them idempotently instead. Declared here so row-level
 * security policies can name them later (`pgPolicy(..., { to: appUser })`).
 */
export const appUser = pgRole('app_user').existing();
export const iamService = pgRole('iam_service').existing();

export type DbRole = 'app_user' | 'iam_service';
