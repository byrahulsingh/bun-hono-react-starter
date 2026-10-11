// First import: validates the environment before any other module reads it.
import '#/libs/env';

import { connectDb, disconnectDb } from '#/db/db';
import { env } from '#/libs/env';
import { logger } from '#/libs/logger';
import { servesWeb } from '#/middleware/static.middleware';
import { announceSetupIfNeeded } from '#/modules/tenancy';

import app from './app';

const log = logger.server;

await connectDb();
await announceSetupIfNeeded();

const server = Bun.serve({
  port: env.PORT,
  hostname: '0.0.0.0',
  fetch: app.fetch,
});

// env.ts does not log — it has no logger by design — so this is where the
// resolved environment first becomes visible.
log.info(
  { env: env.NODE_ENV, web: servesWeb, appUrl: env.APP_URL, basePath: env.BASE_PATH || '/' },
  `Listening on port ${server.port}`,
);

// Containers get SIGTERM on every deploy and scale-down. Stop taking requests,
// then close the pool so Postgres frees the connections now instead of when
// they time out.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    log.info(`${signal} — shutting down`);
    await server.stop();
    await disconnectDb();
    process.exit(0);
  });
}

// Named, not default: Bun auto-serves a default export that has `fetch`, which
// would start a second server next to the one above.
export { app };
