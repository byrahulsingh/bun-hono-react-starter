/**
 * The mail server set in the dashboard. Uses the real registry (no memory
 * sender) and the local Mailpit from compose.yaml (SMTP on :1025, API on
 * :8025), which `bun run db:up` starts with Postgres.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db, withApp } from '#/db/db';
import { emailSender, forgetEmailSender } from '#/modules/providers/email';
import { writeProviderSetting } from '#/modules/providers/settings-store';
import { sendDueEmails } from '#/modules/notifications';

import { acceptNew, call, freshIp, inviteToken, OWNER, resetDb, roleId, setupInstall } from './helpers';

beforeEach(async () => {
  await resetDb();
  forgetEmailSender();
});
afterEach(() => setSystemTime());

const MAILPIT = { host: 'localhost', port: 1025, security: 'starttls' };
const FROM = `Acme <hello-${Date.now()}@acme.test>`;

async function owner() {
  return (await setupInstall()).tokens.access_token;
}

const actions = async () =>
  [...(await db.execute<{ action: string; changes: any }>(sql`select action, changes from audit_logs order by created_at`))];

describe('the mail server in the dashboard', () => {
  test('owners only; checked before saving; then used, and shown without the password', async () => {
    const token = await owner();
    await call('POST', '/invitations', { token, body: { email: 'ines@acme.test', role_id: await roleId('admin') } });
    const admin = (await acceptNew(await inviteToken('ines@acme.test'))).tokens.access_token;

    const before = await call('GET', '/settings/email', { token });
    expect(before.body.data.config.source).toBe('development');
    expect(before.body.data.you_are_owner).toBe(true);
    expect((await call('GET', '/settings/email', { token: admin })).body.data.you_are_owner).toBe(false);
    expect((await call('PUT', '/settings/email/server', { token: admin, body: { ...MAILPIT, from: FROM } })).status).toBe(403);

    // Nothing listens on port 1: refused, with the reason, and nothing saved.
    const wrong = await call('PUT', '/settings/email/server', { token, body: { ...MAILPIT, port: 1, from: FROM } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toContain("Couldn't connect to localhost:1");
    expect((await call('GET', '/settings/email', { token })).body.data.config.source).toBe('development');

    const badFrom = await call('PUT', '/settings/email/server', { token, body: { ...MAILPIT, from: 'not an address' } });
    expect(badFrom.body.error?.details?.from).toBe('Use an address, or Name <address>');

    expect((await call('POST', '/settings/email/server/test', { token, body: { ...MAILPIT, from: FROM } })).status).toBe(200);
    expect((await call('PUT', '/settings/email/server', { token, body: { ...MAILPIT, from: FROM } })).status).toBe(200);
    const after = await call('GET', '/settings/email', { token });
    expect(after.body.data.config).toMatchObject({ source: 'dashboard', host: 'localhost', port: 1025, secure: false, from: FROM, password_set: false });

    // Email now goes out through it: a reset link, sent by the outbox, arrives at Mailpit from FROM.
    await call('POST', '/auth/forgot-password', { body: { email: OWNER.email }, ip: freshIp() });
    expect(await sendDueEmails()).toBe(2); // Ines's invitation too
    const rows = [...(await db.execute<{ sent: Date | null; error: string | null }>(sql`select sent_at as sent, last_error as error from outbox`))];
    expect(rows.every((r) => r.sent !== null && r.error === null)).toBe(true);
    const found = (await (await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`from:"${FROM.match(/<(.+)>/)![1]}"`)}`)).json()) as {
      messages: { Subject: string }[];
    };
    expect(found.messages.map((m) => m.Subject)).toContain('Reset your password');

    const saved = (await actions()).find((a) => a.action === 'email.server_saved');
    expect(saved?.changes).toMatchObject({ host: 'localhost', port: 1025, security: 'starttls', password: 'kept' });
  });

  test('a username needs a password; the password is stored encrypted and never shown', async () => {
    const token = await owner();
    const noPassword = await call('PUT', '/settings/email/server', { token, body: { ...MAILPIT, user: 'mailer', from: FROM } });
    expect(noPassword.body.error?.details?.password).toBe('Enter the password for this username');

    const [me] = [...(await db.execute<{ id: string }>(sql`select id from profiles limit 1`))];
    await withApp((tx) =>
      writeProviderSetting(tx, 'email', {
        config: { host: 'smtp.example.com', port: 587, secure: false, user: 'mailer', from: FROM },
        secret: { password: 'very-secret-password' },
        updatedBy: me!.id,
      }),
    );
    const shown = await call('GET', '/settings/email', { token });
    expect(shown.body.data.config).toMatchObject({ source: 'dashboard', user: 'mailer', password_set: true });
    expect(JSON.stringify(shown.body)).not.toContain('very-secret-password');
    const [stored] = [...(await db.execute<{ s: Uint8Array }>(sql`select secret as s from provider_settings`))];
    expect(Buffer.from(stored!.s).toString()).not.toContain('very-secret-password');
  });

  test('another process (the worker) picks a change up within seconds', async () => {
    await owner();
    const first = await emailSender();
    expect(await emailSender()).toBe(first); // cached

    const [me] = [...(await db.execute<{ id: string }>(sql`select id from profiles limit 1`))];
    // Saved by "the API": no forgetEmailSender() in this process.
    await withApp((tx) =>
      writeProviderSetting(tx, 'email', {
        config: { host: 'localhost', port: 1025, secure: false, user: null, from: FROM },
        secret: null,
        updatedBy: me!.id,
      }),
    );
    expect(await emailSender()).toBe(first); // still within the re-check time
    setSystemTime(new Date(Date.now() + 6_000));
    expect(await emailSender()).not.toBe(first);
  });

  test('removing it goes back to the environment (here: development, Mailpit)', async () => {
    const token = await owner();
    await call('PUT', '/settings/email/server', { token, body: { ...MAILPIT, from: FROM } });
    expect((await call('DELETE', '/settings/email/server', { token })).status).toBe(200);
    expect((await call('GET', '/settings/email', { token })).body.data.config.source).toBe('development');
    expect((await actions()).map((a) => a.action)).toContain('email.server_removed');
  });
});
