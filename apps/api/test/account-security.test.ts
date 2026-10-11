import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '#/db/db';
import { base32Decode, stepAt, totpCode } from '#/modules/iam/totp';

import { call, deviceKey, freshIp, OWNER, outboxEmails, resetDb, setupInstall } from './helpers';

beforeEach(resetDb);

const LAPTOP = 'laptop-browser-id-0123456789abcdef';
const PHONE = 'phone-browser-id-0123456789abcdefgh';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function signIn(browserId?: string, email = OWNER.email, password = OWNER.password) {
  const device = await deviceKey();
  const ip = freshIp();
  const res = await call('POST', '/auth/login', {
    body: { email, password, device_public_key: device.publicJwk, ...(browserId && { browser_id: browserId }) },
    ip,
    userAgent: MAC_CHROME,
  });
  return { res, ip, token: res.body.data?.access_token as string };
}

const subjects = async () => (await outboxEmails()).map((e) => e.subject);
const linkToken = (text: string, path: string) =>
  new URL(text.match(new RegExp(`https?://\\S*${path}\\S*`))![0]).searchParams.get('token')!;
const actions = async () =>
  [...(await db.execute<{ action: string }>(sql`select action from audit_logs order by created_at`))].map((r) => r.action);

describe('new-device sign-in alerts', () => {
  test('the first browser is quiet; the same browser again is quiet; a new one is reported', async () => {
    await setupInstall(); // no browser id: nothing learned yet
    await signIn(LAPTOP); // the first browser we learn about
    await signIn(LAPTOP);
    expect(await subjects()).not.toContain('New sign-in to your account');

    const phone = await signIn(PHONE);
    const alerts = (await outboxEmails()).filter((e) => e.subject === 'New sign-in to your account');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.to).toBe(OWNER.email);
    expect(alerts[0]!.text).toContain('Chrome on macOS');
    expect(alerts[0]!.text).toContain(phone.ip);

    // Known now: no second email for the same browser.
    await signIn(PHONE);
    expect((await subjects()).filter((s) => s === 'New sign-in to your account')).toHaveLength(1);
    // Only a hash of the browser id is stored.
    const stored = [...(await db.execute<{ h: string }>(sql`select encode(browser_hash, 'escape') as h from iam.known_devices`))];
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.h).join()).not.toContain(PHONE);
  });

  test('a sign-in without a browser id counts as new once a browser is known', async () => {
    await setupInstall();
    await signIn(LAPTOP);
    await signIn(undefined);
    expect(await subjects()).toContain('New sign-in to your account');
  });

  test("\"This wasn't me\": shows the sign-in, signs that session out once, forgets the browser", async () => {
    await setupInstall();
    await signIn(LAPTOP);
    const intruder = await signIn(PHONE);
    const mail = (await outboxEmails()).find((e) => e.subject === 'New sign-in to your account')!;
    const token = linkToken(mail.text, '/sign-in-alert');

    const preview = await call('POST', '/auth/sign-in-alert/preview', { body: { token } });
    expect(preview.body.data).toMatchObject({ ip: intruder.ip, user_agent: MAC_CHROME, session_active: true });
    expect((await call('GET', '/auth/sessions', { token: intruder.token })).status).toBe(200);

    expect((await call('POST', '/auth/sign-in-alert/report', { body: { token } })).status).toBe(200);
    expect((await call('GET', '/auth/sessions', { token: intruder.token })).status).toBe(401);
    // Once only.
    const again = await call('POST', '/auth/sign-in-alert/report', { body: { token } });
    expect(again.body.error?.code).toBe('LINK_INVALID');
    expect(await actions()).toContain('auth.sign_in_reported');

    // That browser is a stranger again: signing in from it is reported again.
    await signIn(PHONE);
    expect((await subjects()).filter((s) => s === 'New sign-in to your account')).toHaveLength(2);
  });

  test('a made-up or expired link is refused', async () => {
    expect((await call('POST', '/auth/sign-in-alert/preview', { body: { token: 'not-a-real-token' } })).body.error?.code).toBe('LINK_INVALID');
    await setupInstall();
    await signIn(LAPTOP);
    await signIn(PHONE);
    const token = linkToken((await outboxEmails()).find((e) => e.subject === 'New sign-in to your account')!.text, '/sign-in-alert');
    await db.execute(sql`update iam.sign_in_alerts set expires_at = now() - interval '1 second'`);
    expect((await call('POST', '/auth/sign-in-alert/report', { body: { token } })).body.error?.code).toBe('LINK_INVALID');
  });

  test('an odd browser id never blocks a sign-in', async () => {
    await setupInstall();
    const { res } = await signIn('not valid!');
    expect(res.status).toBe(200);
  });
});

describe('changing your sign-in email', () => {
  const NEW = 'asha@new.test';

  test('password, link to the new address, then the email changes and the old one is told', async () => {
    const { tokens } = await setupInstall();
    const token = tokens.access_token;

    const wrong = await call('POST', '/auth/email-change', { token, body: { new_email: NEW, password: 'not it at all' } });
    expect(wrong.body.error?.details).toEqual({ password: 'Incorrect password' });
    const same = await call('POST', '/auth/email-change', { token, body: { new_email: OWNER.email, password: OWNER.password } });
    expect(same.body.error?.details).toEqual({ new_email: 'This is already your email' });

    const asked = await call('POST', '/auth/email-change', { token, body: { new_email: 'Asha@New.test', password: OWNER.password } });
    expect(asked.status).toBe(200);
    expect(asked.body.data.new_email).toBe(NEW);
    expect((await call('GET', '/auth/email-change', { token })).body.data.new_email).toBe(NEW);
    // Nothing has changed yet.
    expect((await call('GET', '/me', { token })).body.data.user.email).toBe(OWNER.email);

    const mail = (await outboxEmails()).at(-1)!;
    expect(mail).toMatchObject({ to: NEW, subject: 'Confirm your new sign-in email' });
    const link = linkToken(mail.text, '/confirm-email');

    const confirmed = await call('POST', '/auth/email-change/confirm', { body: { token: link } });
    expect(confirmed.body.data).toEqual({ email: NEW });
    expect((await call('GET', '/me', { token })).body.data.user.email).toBe(NEW); // still signed in
    expect((await call('GET', '/auth/email-change', { token })).body.data).toBeNull();
    const notice = (await outboxEmails()).at(-1)!;
    expect(notice).toMatchObject({ to: OWNER.email, subject: 'Your sign-in email was changed' });
    expect(notice.text).toContain('a…@new.test');
    expect(await actions()).toEqual(expect.arrayContaining(['auth.email_change_requested', 'auth.email_changed']));

    // The link works once; the new address signs in, the old one no longer does.
    expect((await call('POST', '/auth/email-change/confirm', { body: { token: link } })).body.error?.code).toBe('LINK_INVALID');
    expect((await signIn(undefined, NEW)).res.status).toBe(200);
    expect((await signIn(undefined, OWNER.email)).res.body.error?.code).toBe('INVALID_CREDENTIALS');
  });

  test('asking again replaces the link; cancelling voids it', async () => {
    const { tokens } = await setupInstall();
    const token = tokens.access_token;
    await call('POST', '/auth/email-change', { token, body: { new_email: 'first@new.test', password: OWNER.password } });
    const first = linkToken((await outboxEmails()).at(-1)!.text, '/confirm-email');
    await call('POST', '/auth/email-change', { token, body: { new_email: NEW, password: OWNER.password } });
    const second = linkToken((await outboxEmails()).at(-1)!.text, '/confirm-email');
    expect((await call('POST', '/auth/email-change/confirm', { body: { token: first } })).body.error?.code).toBe('LINK_INVALID');

    await call('DELETE', '/auth/email-change', { token });
    expect((await call('POST', '/auth/email-change/confirm', { body: { token: second } })).body.error?.code).toBe('LINK_INVALID');
    expect((await call('GET', '/me', { token })).body.data.user.email).toBe(OWNER.email);
  });

  test('an address another account uses is refused, when asked and when confirmed', async () => {
    const { tokens } = await setupInstall();
    const token = tokens.access_token;
    await call('POST', '/auth/email-change', { token, body: { new_email: NEW, password: OWNER.password } });
    const link = linkToken((await outboxEmails()).at(-1)!.text, '/confirm-email');

    // Someone else gets the address in the meantime.
    await db.execute(sql`insert into iam.users (id, email) values (gen_random_uuid(), ${NEW})`);
    const taken = await call('POST', '/auth/email-change', { token, body: { new_email: NEW, password: OWNER.password } });
    expect(taken.body.error?.details).toEqual({ new_email: 'Another account uses this email' });
    expect((await call('POST', '/auth/email-change/confirm', { body: { token: link } })).body.error?.code).toBe('CONFLICT');
    expect((await call('GET', '/me', { token })).body.data.user.email).toBe(OWNER.email);
  });

  test('with two-factor on, a code is needed too', async () => {
    const { tokens } = await setupInstall();
    const token = tokens.access_token;
    const setup = await call('POST', '/auth/two-factor/setup', { token, body: { password: OWNER.password } });
    const secret = base32Decode(setup.body.data.secret);
    const now = stepAt(Date.now() / 1000);
    await call('POST', '/auth/two-factor/confirm', { token, body: { code: totpCode(secret, now) } });

    const noCode = await call('POST', '/auth/email-change', { token, body: { new_email: NEW, password: OWNER.password } });
    expect(noCode.body.error?.details).toEqual({ code: 'Enter a code from your app' });
    const wrong = await call('POST', '/auth/email-change', { token, body: { new_email: NEW, password: OWNER.password, code: '000000' } });
    expect(wrong.body.error?.details).toEqual({ code: 'Incorrect code' });
    const ok = await call('POST', '/auth/email-change', {
      token,
      body: { new_email: NEW, password: OWNER.password, code: totpCode(secret, now + 1) },
    });
    expect(ok.status).toBe(200);
  });

  test('confirming cancels an open password-reset link sent to the old address', async () => {
    const { tokens } = await setupInstall();
    const token = tokens.access_token;
    await call('POST', '/auth/forgot-password', { body: { email: OWNER.email } });
    const reset = linkToken((await outboxEmails()).at(-1)!.text, '/reset-password');
    await call('POST', '/auth/email-change', { token, body: { new_email: NEW, password: OWNER.password } });
    await call('POST', '/auth/email-change/confirm', { body: { token: linkToken((await outboxEmails()).at(-1)!.text, '/confirm-email') } });

    const device = await deviceKey();
    const used = await call('POST', '/auth/reset-password', {
      body: { token: reset, password: 'a long new password', device_public_key: device.publicJwk },
    });
    expect(used.body.error?.code).toBe('LINK_INVALID');
  });
});
