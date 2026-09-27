import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql/postgres';

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

export const db = drizzle({ client });

/**
 * Bun opens connections lazily, on the first query. Run one at boot so a wrong
 * DATABASE_URL or an unreachable database stops the server immediately, instead
 * of surfacing as a 500 on the first real request.
 */
export async function connectDb() {
  await client`select 1`;
  logger.db.info({ poolMax: env.DB_POOL_MAX }, 'Database connected');
}

export async function disconnectDb() {
  await client.close();
  logger.db.info('Database disconnected');
}
