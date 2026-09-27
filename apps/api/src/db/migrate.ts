import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sql/postgres/migrator';

import { logger } from '#/libs/logger';

import { client, db, disconnectDb } from './db';

// Any fixed number; it only has to be the same for every process that migrates.
const MIGRATION_LOCK_ID = 872_401;

const migrationsFolder = join(import.meta.dir, '../../drizzle');

// A fresh project has no migrations until the first `db:generate`. That is
// not a failure: the deploy step that runs this must still pass.
if (!existsSync(migrationsFolder)) {
  logger.db.warn({ migrationsFolder }, 'No migrations folder yet — nothing to apply');
  await disconnectDb();
  process.exit(0);
}

// Advisory lock: if several containers start at once, only one runs migrations
// and the others wait, then find nothing left to apply.
const lock = await client.reserve();
try {
  await lock`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
  await migrate(db, { migrationsFolder });
  logger.db.info('Migrations applied');
} finally {
  await lock`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  lock.release();
  await disconnectDb();
}
