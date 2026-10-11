/**
 * Hourly upkeep in the worker process: rotate the token signing key when due,
 * and delete finished rows that would otherwise pile up (ended sessions, used
 * links, old rate-limit windows, retired keys, sent emails).
 *
 * Each task runs on its own, so one failing does not stop the others, and a
 * failure is logged and tried again next hour. Several workers may run this
 * at once; every task is safe to repeat.
 */

import { logger } from '#/libs/logger';
import { cleanUpIam, rotateSigningKeyIfDue } from '#/modules/iam';
import { cleanUpOutbox } from '#/modules/notifications';

const log = logger.worker;
const HOUR = 60 * 60 * 1000;

/** One pass of every task. Returns what each did (for logs and tests). */
export async function runMaintenance() {
  const result: Record<string, unknown> = {};
  const task = async (name: string, fn: () => Promise<unknown>) => {
    try {
      result[name] = await fn();
    } catch (err) {
      result[name] = 'failed';
      log.error({ err, task: name }, 'Maintenance task failed; will retry next run');
    }
  };
  await task('signingKeyRotated', rotateSigningKeyIfDue);
  await task('iam', cleanUpIam);
  await task('outbox', cleanUpOutbox);
  log.info(result, 'Maintenance done');
  return result;
}

/** Runs shortly after start, then every hour. Returns a stop function. */
export function startMaintenance(intervalMs = HOUR): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  const run = () => {
    if (stopped) return;
    running = runMaintenance();
  }
  // A minute after start: let a deploy settle first.
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, intervalMs);
  return async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(every);
    await running;
  };
}
