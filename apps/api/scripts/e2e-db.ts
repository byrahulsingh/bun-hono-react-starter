/**
 * The browser tests' own database (apps/e2e), next to the developer's: same
 * server as DATABASE_URL, database `app_e2e`. Anything not named `*_e2e` is
 * refused, so a slip can never wipe real data.
 *
 *   bun scripts/e2e-db.ts reset        empty it and migrate (the server script does this)
 *   bun scripts/e2e-db.ts sql "<sql>"  run one statement, print the rows as JSON (tests use it
 *                                      to set up states the UI cannot reach, e.g. a failed email)
 */

import { SQL } from 'bun';

export const E2E_DATABASE = 'app_e2e';

/** DATABASE_URL (from .env) pointed at the e2e database. */
export function e2eDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set: copy apps/api/.env.example to apps/api/.env.');
  const url = new URL(base);
  url.pathname = `/${E2E_DATABASE}`;
  return url.toString();
}

function assertE2e(url: string) {
  if (!new URL(url).pathname.endsWith('_e2e')) throw new Error(`Refusing to touch ${new URL(url).pathname}: not an *_e2e database.`);
}

export async function resetE2eDatabase(): Promise<void> {
  const url = e2eDatabaseUrl();
  assertE2e(url);
  // Dropping needs a connection to another database on the same server.
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const sql = new SQL({ url: admin.toString(), max: 1 });
  try {
    await sql.unsafe(`drop database if exists ${E2E_DATABASE} with (force)`);
    await sql.unsafe(`create database ${E2E_DATABASE}`);
  } finally {
    await sql.close();
  }
  const migrate = Bun.spawn(['bun', 'src/db/migrate.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, DATABASE_URL: url, LOG_LEVEL: 'warn' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await migrate.exited) !== 0) throw new Error('Migrating the e2e database failed.');
}

async function runSql(statement: string): Promise<unknown[]> {
  const url = e2eDatabaseUrl();
  assertE2e(url);
  const sql = new SQL({ url, max: 1 });
  try {
    return [...(await sql.unsafe(statement))];
  } finally {
    await sql.close();
  }
}

if (import.meta.main) {
  const [command, statement] = process.argv.slice(2);
  if (command === 'reset') await resetE2eDatabase();
  else if (command === 'sql' && statement) console.log(JSON.stringify(await runSql(statement)));
  else {
    console.error('Usage: bun scripts/e2e-db.ts reset | sql "<statement>"');
    process.exit(2);
  }
}
