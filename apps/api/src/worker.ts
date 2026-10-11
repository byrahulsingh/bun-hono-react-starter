// The worker process: same code and image as the API, different command.
// Background work lives here so no request waits on it.

// First import: validates the environment before any other module reads it.
import '#/libs/env';

import { connectDb, disconnectDb } from '#/db/db';
import { logger } from '#/libs/logger';
import { startMaintenance } from '#/modules/maintenance';
import { startOutboxWorker } from '#/modules/notifications';
import { emailSender } from '#/modules/providers/email';

const log = logger.worker;

await connectDb();

// Check the mail server once at start. A failure is logged, not fatal: the
// outbox keeps retrying, an SMTP blip at deploy time must not crash-loop, and
// a new install sets its mail server up in the dashboard after starting.
const sender = await emailSender();
try {
  await sender.verify();
  log.info({ sender: sender.name }, 'Email sender ready');
} catch (err) {
  log.error({ err, sender: sender.name }, 'Email sender check failed — emails will retry until it works');
}

const stopOutbox = startOutboxWorker();
const stopMaintenance = startMaintenance();
log.info('Worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    log.info(`${signal} — finishing the current batch, then stopping`);
    await Promise.all([stopOutbox(), stopMaintenance()]);
    await disconnectDb();
    process.exit(0);
  });
}
