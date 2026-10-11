/**
 * The API the browser tests run against (apps/e2e starts it; no need to run
 * it by hand): a fresh `app_e2e` database, then the API on :4100 and the
 * worker, side by side with the developer's own on :4000. Stops both when
 * stopped.
 */

import { E2E_DATABASE, e2eDatabaseUrl, resetE2eDatabase } from './e2e-db';

export const E2E_API_PORT = 4100;
export const E2E_APP_URL = 'http://localhost:3100';
export const E2E_SETUP_TOKEN = 'e2e-setup-token-0123456789abcdef';

await resetE2eDatabase();

const env = {
  ...process.env,
  NODE_ENV: 'development',
  LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
  DATABASE_URL: e2eDatabaseUrl(),
  PORT: String(E2E_API_PORT),
  APP_URL: E2E_APP_URL,
  SETUP_TOKEN: E2E_SETUP_TOKEN,
  // Each browser context sends its own address, so rate limits per IP never
  // trip across a long run (the API reads the right-most entry).
  CLIENT_IP_SOURCE: 'x-forwarded-for',
  // Always the local Mailpit, whatever .env says: tests must never send real
  // email. An empty value counts as unset (libs/env.ts).
  SMTP_HOST: '',
  SMTP_PORT: '',
  SMTP_SECURE: '',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  MAIL_FROM: '',
};

const cwd = `${import.meta.dir}/..`;
const children = [
  Bun.spawn(['bun', 'src/index.ts'], { cwd, env, stdout: 'inherit', stderr: 'inherit' }),
  Bun.spawn(['bun', 'src/worker.ts'], { cwd, env, stdout: 'inherit', stderr: 'inherit' }),
];
console.log(`e2e: API on :${E2E_API_PORT} and worker running against ${E2E_DATABASE}`);

const stop = () => {
  for (const child of children) child.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// If either one dies, stop the other too: half a stack fails in confusing ways.
const code = await Promise.race(children.map((c) => c.exited));
stop();
await Promise.all(children.map((c) => c.exited));
process.exit(code);
