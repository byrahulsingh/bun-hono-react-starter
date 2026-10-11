/**
 * Sends what enqueueEmail() queued. Runs in the worker process (src/worker.ts).
 *
 * Several workers can run at once: each claims a batch with
 * `for update skip locked`, so no email is picked twice, and a claim expires
 * on its own if its worker dies. A failed send is retried with growing
 * delays, then given up and logged.
 */

import { lt, or, sql } from 'drizzle-orm';

import { withApp } from '#/db/db';
import { outbox } from '#/db/schema';
import { decrypt } from '#/libs/crypto';
import { logger } from '#/libs/logger';
import { getBranding } from '#/modules/branding';
import type { EmailMessage } from '#/modules/providers/email';
import { emailSender } from '#/modules/providers/email';

import type { EmailContent } from './email-layout';
import { renderEmail } from './email-layout';
import { OUTBOX_PAYLOAD_CONTEXT } from './outbox';

const log = logger.email;

const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 8;
/** 30 s, 1 min, 2 min, … capped at 1 h: about 4 hours of retries in total. */
const backoffSeconds = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 3600);

type Claimed = {
  id: string;
  payload: Uint8Array | null;
  attempts: number;
};

/** Sends one batch of due emails. Returns how many were claimed. */
export async function sendDueEmails(): Promise<number> {
  const claimed = await withApp((tx) =>
    tx.execute<Claimed>(sql`
      update outbox set locked_until = now() + interval '2 minutes', attempts = attempts + 1
      where id in (
        select id from outbox
        where kind = 'email' and sent_at is null and failed_at is null and run_after <= now()
          and (locked_until is null or locked_until < now())
        order by run_after
        limit ${BATCH_SIZE}
        for update skip locked
      )
      returning id, payload, attempts`),
  );

  for (const row of claimed) {
    try {
      if (!row.payload) throw new Error('Empty payload');
      const stored = JSON.parse(new TextDecoder().decode(await decrypt(row.payload, OUTBOX_PAYLOAD_CONTEXT))) as EmailContent | EmailMessage;
      // Queued before the layout existed: already finished text, sent as it is.
      const message = 'paragraphs' in stored ? renderEmail(stored, await getBranding()) : stored;
      await (await emailSender()).send(message);
      // The payload may hold a single-use link: do not keep it once sent.
      await withApp((tx) =>
        tx.execute(sql`update outbox set sent_at = now(), payload = null, locked_until = null, last_error = null where id = ${row.id}`),
      );
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 500) : String(err);
      if (row.attempts >= MAX_ATTEMPTS) {
        log.error({ outboxId: row.id, attempts: row.attempts, error }, 'Email given up after repeated failures');
        await withApp((tx) =>
          tx.execute(sql`update outbox set failed_at = now(), payload = null, locked_until = null, last_error = ${error} where id = ${row.id}`),
        );
      } else {
        const delay = backoffSeconds(row.attempts);
        log.warn({ outboxId: row.id, attempts: row.attempts, retryInSeconds: delay, error }, 'Email failed; will retry');
        await withApp((tx) =>
          tx.execute(sql`
            update outbox set run_after = now() + make_interval(secs => ${delay}), locked_until = null, last_error = ${error}
            where id = ${row.id}`),
        );
      }
    }
  }
  return claimed.length;
}

/**
 * Polls every `intervalMs` (an indexed query, cheap), and goes again at once
 * after a full batch. Returns a stop function that waits for the current batch.
 */
export function startOutboxWorker(intervalMs = 2000): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = () => {
    running = (async () => {
      try {
        const count = await sendDueEmails();
        if (!stopped) timer = setTimeout(tick, count === BATCH_SIZE ? 0 : intervalMs);
      } catch (err) {
        log.error({ err }, 'Outbox poll failed');
        if (!stopped) timer = setTimeout(tick, intervalMs * 5);
      }
    })();
  };
  tick();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

/** Sent messages (already emptied) after a week; given-up ones after a month, for looking into. */
export async function cleanUpOutbox(): Promise<number> {
  const day = 24 * 60 * 60 * 1000;
  const deleted = await withApp((tx) =>
    tx
      .delete(outbox)
      .where(or(lt(outbox.sent_at, new Date(Date.now() - 7 * day)), lt(outbox.failed_at, new Date(Date.now() - 30 * day))))
      .returning({ id: outbox.id }),
  );
  return deleted.length;
}
