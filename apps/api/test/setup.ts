// Runs once before the test files (bunfig.toml). Tests use a real Postgres:
// the role switching, grants and row locks are exactly what needs testing.
import { env } from '#/libs/env';

if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Tests wipe the database: DATABASE_URL must point at a *_test database (see .env.test).');
}

const { runMigrations } = await import('#/db/migrate');
await runMigrations();
