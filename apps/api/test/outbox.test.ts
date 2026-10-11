import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '#/db/db';
import { sendDueEmails } from '#/modules/notifications';
import { memorySender, useEmailSender } from '#/modules/providers/email';

import { call, freshIp, OWNER, resetDb, setupInstall } from './helpers';

const mail = memorySender();

beforeEach(async () => {
  await resetDb();
  mail.sent.length = 0;
  mail.failNext = 0;
  useEmailSender(mail);
});
afterAll(() => useEmailSender(null));

async function queueResetEmail() {
  await setupInstall();
  await call('POST', '/auth/forgot-password', { body: { email: OWNER.email }, ip: freshIp() });
}

const outboxRow = async () =>
  [...(await db.execute<{ sent_at: Date | null; failed_at: Date | null; payload: unknown; attempts: number; last_error: string | null }>(
    sql`select sent_at, failed_at, payload, attempts, last_error from outbox`,
  ))][0]!;

describe('outbox worker', () => {
  test('sends queued emails once and forgets their content', async () => {
    await queueResetEmail();
    expect(await sendDueEmails()).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(OWNER.email);
    expect(mail.sent[0]!.subject).toBe('Reset your password');

    const row = await outboxRow();
    expect(row.sent_at).not.toBeNull();
    expect(row.payload).toBeNull(); // the reset link is not kept after sending

    expect(await sendDueEmails()).toBe(0);
    expect(mail.sent).toHaveLength(1);
  });

  test('a failed send is retried later, not lost', async () => {
    await queueResetEmail();
    mail.failNext = 1;
    await sendDueEmails();
    let row = await outboxRow();
    expect(row.sent_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('simulated failure');

    // Not due yet: the retry waits.
    expect(await sendDueEmails()).toBe(0);

    await db.execute(sql`update outbox set run_after = now()`);
    await sendDueEmails();
    row = await outboxRow();
    expect(row.sent_at).not.toBeNull();
    expect(mail.sent).toHaveLength(1);
  });

  test('gives up after the last attempt', async () => {
    await queueResetEmail();
    await db.execute(sql`update outbox set attempts = 7`);
    mail.failNext = 1;
    await sendDueEmails();
    const row = await outboxRow();
    expect(row.failed_at).not.toBeNull();
    expect(row.payload).toBeNull();
  });
});
