/**
 * First run on a fresh clone, after `bun install` and `bun run db:up`:
 *
 *   bun run init
 *
 *   1. apps/api/.env       from .env.example, with a new APP_SECRET
 *   2. apps/api/.env.test  for `bun run test` (Bun loads it when NODE_ENV is test)
 *   3. the test database, next to the one in DATABASE_URL
 *   4. migrations on the development database
 *
 * Safe to run again: an existing file is never overwritten, and the database
 * steps do nothing when there is nothing to do. Secrets go into the files and
 * nowhere else; they are never printed.
 */

import { randomBytes } from 'node:crypto';
import { relative } from 'node:path';

import { SQL } from 'bun';

const dir = `${import.meta.dir}/..`;
const shown = (path: string) => relative(process.cwd(), path) || path;
/** 64 characters; base64url, so nothing in it needs quoting in a .env file. */
const newSecret = () => randomBytes(48).toString('base64url');

async function writeOnce(path: string, content: string): Promise<void> {
  if (await Bun.file(path).exists()) {
    console.log(`  kept     ${shown(path)} (already there)`);
    return;
  }
  await Bun.write(path, content);
  console.log(`  created  ${shown(path)}`);
}

function valueIn(envFile: string, key: string): string | null {
  const match = envFile.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match?.[1]?.trim() || null;
}

console.log('Environment files:');
const example = await Bun.file(`${dir}/.env.example`).text();
await writeOnce(`${dir}/.env`, example.replace(/^APP_SECRET=.*$/m, `APP_SECRET=${newSecret()}`));

const databaseUrl = valueIn(await Bun.file(`${dir}/.env`).text(), 'DATABASE_URL');
if (!databaseUrl) {
  console.error('\nDATABASE_URL is empty in apps/api/.env. Set it, then run `bun run init` again.');
  process.exit(1);
}
const testUrl = new URL(databaseUrl);
testUrl.pathname = `${testUrl.pathname.replace(/\/+$/, '')}_test`;
const testDatabase = testUrl.pathname.slice(1);

await writeOnce(
  `${dir}/.env.test`,
  [
    '# For `bun run test`. Tests wipe this database, so it must be named *_test.',
    'NODE_ENV=test',
    'LOG_LEVEL=warn',
    `DATABASE_URL=${testUrl}`,
    'APP_URL=http://localhost:3000',
    `APP_SECRET=${newSecret()}`,
    '# The tests send each request from its own address, so per-IP rate limits never trip.',
    'CLIENT_IP_SOURCE=x-forwarded-for',
    '',
  ].join('\n'),
);

console.log('\nDatabases:');
if (!/^[a-z0-9_]+$/.test(testDatabase)) {
  console.error(`  The test database name "${testDatabase}" may only have a-z, 0-9 and _. Change DATABASE_URL.`);
  process.exit(1);
}
// Creating a database needs a connection to another one on the same server.
const admin = new URL(databaseUrl);
admin.pathname = '/postgres';
const sql = new SQL({ url: admin.toString(), max: 1, connectionTimeout: 5 });
try {
  const [exists] = await sql`select 1 from pg_database where datname = ${testDatabase}`;
  if (exists) console.log(`  kept     ${testDatabase} (already there)`);
  else {
    await sql.unsafe(`create database ${testDatabase}`);
    console.log(`  created  ${testDatabase}`);
  }
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`  Couldn't reach Postgres at ${admin.host} (${reason}).`);
  console.error('  Start it with `bun run db:up`, then run `bun run init` again.');
  process.exit(1);
} finally {
  await sql.close();
}

const migrate = Bun.spawn(['bun', 'src/db/migrate.ts'], {
  cwd: dir,
  env: { ...process.env, LOG_LEVEL: 'warn' },
  stdout: 'inherit',
  stderr: 'inherit',
});
if ((await migrate.exited) !== 0) {
  console.error('  Migrating the development database failed (above).');
  process.exit(1);
}
console.log(`  migrated ${new URL(databaseUrl).pathname.slice(1)}`);

console.log('\nReady. Next: `bun run dev`, then open http://localhost:3000 and follow the setup link in the API log.');
