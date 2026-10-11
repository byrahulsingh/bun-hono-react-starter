import { SQL } from 'bun';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sql/postgres';

import type { DbRole } from '#/db/roles';
import { env } from '#/libs/env';
import { logger } from '#/libs/logger';

// One connection pool per process. The database sees
// (app replicas + worker replicas) × DB_POOL_MAX connections in total.
export const client = new SQL({
  url: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeout: 30, // seconds before an idle connection is closed
  maxLifetime: 60 * 30, // recycle connections every 30 min
  connectionTimeout: 10, // fail fast if the database is unreachable
});

/**
 * Connected as the login role, which owns the tables and is allowed
 * everything. Only migrations and the catalog / access sync use it directly;
 * everything else goes through `withApp` / `withIam` below.
 */
export const db = drizzle({ client });

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `fn` in a transaction as `role`. `set local` lasts until the
 * transaction ends, so the pooled connection goes back clean; grants (and,
 * later, row-level security) then apply exactly as for that role.
 */
async function asRole<T>(role: DbRole, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${role}`));
    return fn(tx);
  });
}

/** Product code: tables in `public`, no access to schema `iam`. */
export const withApp = <T>(fn: (tx: Tx) => Promise<T>) => asRole('app_user', fn);

/** The iam module only: schema `iam` plus the few `public` tables it must write. */
export const withIam = <T>(fn: (tx: Tx) => Promise<T>) => asRole('iam_service', fn);

/**
 * True when `err` is Postgres refusing a duplicate (23505), optionally on one
 * named unique index. Drizzle wraps the driver error, so look at the cause too.
 * For the race a check-then-insert cannot close; the check gives the nice
 * message, this catches the rare loser.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    const pg = e as Error & { errno?: unknown; constraint?: unknown };
    if (pg.errno === '23505') return constraint === undefined || pg.constraint === constraint;
  }
  return false;
}

/**
 * Bun opens connections lazily, on the first query. Run one at boot so a wrong
 * DATABASE_URL or an unreachable database stops the server immediately, instead
 * of surfacing as a 500 on the first real request. Also checks that the login
 * role can switch into both database roles: without them every request would
 * fail, so the server refuses to start and says why.
 */
export async function connectDb() {
  const [row] = await client`
    select pg_has_role(current_user, 'app_user', 'set') as app_user,
           pg_has_role(current_user, 'iam_service', 'set') as iam_service
    where exists (select from pg_roles where rolname = 'app_user')
      and exists (select from pg_roles where rolname = 'iam_service')`;
  if (!row?.app_user || !row?.iam_service) {
    throw new Error(
      'Database roles app_user / iam_service are missing, or the login role cannot switch into them. Run the migrate step first (bun run db:migrate).',
    );
  }
  logger.db.info({ poolMax: env.DB_POOL_MAX }, 'Database connected');
}

export async function disconnectDb() {
  await client.close();
  logger.db.info('Database disconnected');
}
