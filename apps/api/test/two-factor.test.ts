import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '#/db/db';
import { base32Decode, stepAt, totpCode } from '#/modules/iam/totp';

import {
  acceptNew,
  call,
  defaultTenantId,
  deviceKey,
  freshIp,
  inviteToken,
  OWNER,
  outboxEmails,
  resetDb,
  roleId,
  setupInstall,
} from './helpers';

beforeEach(resetDb);

const PASSWORD = 'a long new password';

/** The app's code for now, `offset` steps away (each code works once, so tests move along). */
const codeFor = (secret: string, offset = 0) => totpCode(base32Decode(secret), stepAt(Date.now() / 1000) + offset);

async function signIn(email: string, password: string) {
  const device = await deviceKey();
  const res = await call('POST', '/auth/login', { body: { email, password, device_public_key: device.publicJwk }, ip: freshIp() });
  return { res, device, data: res.body.data };
}

async function secondStep(path: string, challenge: string, code: string, device: { publicJwk: unknown }) {
  return call('POST', `/auth/login/two-factor${path}`, { body: { challenge, code, device_public_key: device.publicJwk }, ip: freshIp() });
}

/** Turns two-factor on for a signed-in person; returns the secret and recovery codes. */
async function enable(token: string, password: string) {
  const setup = await call('POST', '/auth/two-factor/setup', { token, body: { password } });
  expect(setup.status).toBe(200);
  const secret = setup.body.data.secret as string;
  const confirmed = await call('POST', '/auth/two-factor/confirm', { token, body: { code: codeFor(secret) } });
  expect(confirmed.status).toBe(200);
  return { secret, recoveryCodes: confirmed.body.data.recovery_codes as string[] };
}

const actions = async () =>
  [...(await db.execute<{ action: string }>(sql`select action from audit_logs order by created_at`))].map((r) => r.action);

async function invitePerson(ownerToken: string, email: string, roleKey: string, tenantId: string | null) {
  await call('POST', tenantId ? `/t/${tenantId}/invitations` : '/invitations', {
    token: ownerToken,
    body: { email, role_id: await roleId(roleKey) },
  });
  return acceptNew(await inviteToken(email), 'New Person', PASSWORD);
}

describe('turning two-factor on and off', () => {
  test('password again, then a working code; recovery codes once; then every sign-in asks for a code', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;

    const wrongPassword = await call('POST', '/auth/two-factor/setup', { token, body: { password: 'not it at all' } });
    expect(wrongPassword.body.error?.details).toEqual({ password: 'Incorrect password' });

    const setup = await call('POST', '/auth/two-factor/setup', { token, body: { password: OWNER.password } });
    const secret = setup.body.data.secret as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    // Not on until a code proves the app works.
    expect((await call('GET', '/auth/two-factor', { token })).body.data.enabled).toBe(false);
    const wrong = await call('POST', '/auth/two-factor/confirm', { token, body: { code: '000000' } });
    expect(wrong.body.error?.details).toEqual({ code: 'Incorrect code' });

    const confirmed = await call('POST', '/auth/two-factor/confirm', { token, body: { code: codeFor(secret) } });
    const codes = confirmed.body.data.recovery_codes as string[];
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(new Set(codes).size).toBe(10);
    expect((await call('GET', '/auth/two-factor', { token })).body.data).toMatchObject({ enabled: true, recovery_codes_left: 10, required: false });
    expect((await outboxEmails()).at(-1)?.subject).toBe('Two-factor sign-in is on');
    // Stored: the secret encrypted, codes only as hashes.
    const [stored] = [...(await db.execute<{ secret: Uint8Array }>(sql`select secret from iam.totp_factors`))];
    expect(Buffer.from(stored!.secret).toString()).not.toContain(secret);
    expect([...(await db.execute(sql`select 1 from iam.recovery_codes where code_hash::text like ${'%' + codes[0] + '%'}`))]).toHaveLength(0);

    // Signing in now takes a code.
    const { data, device } = await signIn(OWNER.email, OWNER.password);
    expect(data.access_token).toBeUndefined();
    expect(data.two_factor).toMatchObject({ step: 'verify', expires_in: 600 });
    const done = await secondStep('', data.two_factor.challenge, codeFor(secret, 1), device);
    expect(done.status).toBe(200);
    expect(done.body.data.access_token).toBeString();
    expect((await call('GET', '/me', { token: done.body.data.access_token })).status).toBe(200);

    // Off again: password and a code.
    const noCode = await call('POST', '/auth/two-factor/disable', { token, body: { password: OWNER.password, code: '123456' } });
    expect(noCode.body.error?.details).toEqual({ code: 'Incorrect code' });
    const off = await call('POST', '/auth/two-factor/disable', { token, body: { password: OWNER.password, code: codes[0] } });
    expect(off.status).toBe(200);
    expect((await signIn(OWNER.email, OWNER.password)).data.access_token).toBeString();
    expect(await actions()).toEqual(expect.arrayContaining(['auth.two_factor_enabled', 'auth.two_factor_disabled']));
  });
});

describe('the code step', () => {
  test('a code works once, only from the device that entered the password, and five wrong ones end the sign-in', async () => {
    const owner = await setupInstall();
    const { secret } = await enable(owner.tokens.access_token, OWNER.password);

    // Another device cannot use the challenge.
    let attempt = await signIn(OWNER.email, OWNER.password);
    const elsewhere = await deviceKey();
    expect((await secondStep('', attempt.data.two_factor.challenge, codeFor(secret, 1), elsewhere)).body.error?.code).toBe('LINK_INVALID');

    // The code used to turn it on (this step) is not accepted again.
    expect((await secondStep('', attempt.data.two_factor.challenge, codeFor(secret), attempt.device)).body.error?.details).toEqual({ code: 'Incorrect code' });
    const ok = await secondStep('', attempt.data.two_factor.challenge, codeFor(secret, 1), attempt.device);
    expect(ok.status).toBe(200);
    // ...and neither is the code just used, nor the challenge.
    attempt = await signIn(OWNER.email, OWNER.password);
    expect((await secondStep('', attempt.data.two_factor.challenge, codeFor(secret, 1), attempt.device)).body.error?.details).toEqual({ code: 'Incorrect code' });
    expect((await secondStep('', 'not-a-challenge', codeFor(secret, -1), attempt.device)).body.error?.code).toBe('LINK_INVALID');

    // Wrong codes count toward the account's lockout and void the challenge.
    await db.execute(sql`delete from iam.rate_limits`);
    attempt = await signIn(OWNER.email, OWNER.password);
    for (let i = 0; i < 4; i++) await secondStep('', attempt.data.two_factor.challenge, '000000', attempt.device);
    const fifth = await secondStep('', attempt.data.two_factor.challenge, '000000', attempt.device);
    expect(fifth.body.error?.details).toEqual({ code: 'Incorrect code' });
    const locked = await secondStep('', attempt.data.two_factor.challenge, codeFor(secret, 1), attempt.device);
    expect(locked.body.error?.code).toBe('RATE_LIMITED');
    expect((await actions()).filter((a) => a === 'auth.two_factor_failed').length).toBeGreaterThanOrEqual(5);
  });

  test('recovery codes: each once, any formatting, and the person is told', async () => {
    const owner = await setupInstall();
    const { recoveryCodes } = await enable(owner.tokens.access_token, OWNER.password);
    const code = recoveryCodes[3]!;

    let attempt = await signIn(OWNER.email, OWNER.password);
    const messy = ` ${code.toUpperCase().replace('-', ' ')} `;
    const ok = await secondStep('', attempt.data.two_factor.challenge, messy, attempt.device);
    expect(ok.status).toBe(200);
    expect((await outboxEmails()).at(-1)).toMatchObject({ subject: 'A recovery code was used to sign in' });
    expect((await outboxEmails()).at(-1)?.text).toContain('9 recovery codes left');
    expect(await actions()).toContain('auth.recovery_code_used');

    attempt = await signIn(OWNER.email, OWNER.password);
    expect((await secondStep('', attempt.data.two_factor.challenge, code, attempt.device)).body.error?.details).toEqual({ code: 'Incorrect code' });
  });

  test('new recovery codes replace the old ones', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const { secret, recoveryCodes } = await enable(token, OWNER.password);
    const fresh = await call('POST', '/auth/two-factor/recovery-codes', { token, body: { code: codeFor(secret, 1) } });
    const newCodes = fresh.body.data.recovery_codes as string[];
    expect(newCodes).toHaveLength(10);
    expect((await outboxEmails()).at(-1)?.subject).toBe('New recovery codes were made');

    const attempt = await signIn(OWNER.email, OWNER.password);
    expect((await secondStep('', attempt.data.two_factor.challenge, recoveryCodes[0]!, attempt.device)).status).toBe(422);
    expect((await secondStep('', attempt.data.two_factor.challenge, newCodes[0]!, attempt.device)).status).toBe(200);
  });

  test('a password reset link does not skip the code', async () => {
    const owner = await setupInstall();
    const { secret } = await enable(owner.tokens.access_token, OWNER.password);
    await call('POST', '/auth/forgot-password', { body: { email: OWNER.email }, ip: freshIp() });
    const link = (await outboxEmails()).filter((e) => e.subject === 'Reset your password').at(-1)!;
    const resetToken = new URL(link.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

    const device = await deviceKey();
    const reset = await call('POST', '/auth/reset-password', {
      body: { token: resetToken, password: 'a brand new password', device_public_key: device.publicJwk },
      ip: freshIp(),
    });
    expect(reset.status).toBe(200);
    expect(reset.body.data.access_token).toBeUndefined();
    expect(reset.body.data.two_factor.step).toBe('verify');
    const done = await secondStep('', reset.body.data.two_factor.challenge, codeFor(secret, 1), device);
    expect(done.body.data.access_token).toBeString();
  });
});

describe('the organization rule', () => {
  test('only someone with two-factor can require it; then admins set it up at sign-in, members are not asked', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();
    await invitePerson(token, 'ada@acme.test', 'admin', null);
    await invitePerson(token, 'ed@acme.test', 'editor', acme);

    const refused = await call('PATCH', '/settings/security', { token, body: { two_factor_policy: 'org_roles' } });
    expect(refused.status).toBe(409);
    await enable(token, OWNER.password);
    let security = (await call('GET', '/settings/security', { token })).body.data;
    expect(security).toEqual({ two_factor_policy: 'off', you_have_two_factor: true, without_two_factor: { org_roles: 1, everyone: 2 } });
    expect((await call('PATCH', '/settings/security', { token, body: { two_factor_policy: 'org_roles' } })).status).toBe(200);
    expect(await actions()).toContain('organization.two_factor_policy_changed');

    // An editor (no organization role) is not asked.
    expect((await signIn('ed@acme.test', PASSWORD)).data.access_token).toBeString();

    // Ada (admin) must set it up before she gets in.
    const ada = await signIn('ada@acme.test', PASSWORD);
    expect(ada.data.two_factor.step).toBe('setup');
    const challenge = ada.data.two_factor.challenge as string;
    // The setup challenge is not a code challenge.
    expect((await secondStep('', challenge, '123456', ada.device)).body.error?.code).toBe('LINK_INVALID');
    const start = await call('POST', '/auth/login/two-factor/setup', { body: { challenge, device_public_key: ada.device.publicJwk }, ip: freshIp() });
    const secret = start.body.data.secret as string;
    expect((await secondStep('/setup/confirm', challenge, '000000', ada.device)).body.error?.details).toEqual({ code: 'Incorrect code' });
    const finished = await secondStep('/setup/confirm', challenge, codeFor(secret), ada.device);
    expect(finished.status).toBe(200);
    expect(finished.body.data.access_token).toBeString();
    expect(finished.body.data.recovery_codes).toHaveLength(10);
    const adaToken = finished.body.data.access_token as string;

    // While required, she cannot turn it off.
    const off = await call('POST', '/auth/two-factor/disable', { token: adaToken, body: { password: PASSWORD, code: codeFor(secret, 1) } });
    expect(off.status).toBe(409);
    expect((await call('GET', '/auth/two-factor', { token: adaToken })).body.data.required).toBe(true);

    security = (await call('GET', '/settings/security', { token })).body.data;
    expect(security.without_two_factor).toEqual({ org_roles: 0, everyone: 1 });
  });

  test('"everyone": a new person sets it up as they accept their invitation', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    await enable(token, OWNER.password);
    await call('PATCH', '/settings/security', { token, body: { two_factor_policy: 'everyone' } });

    const acme = await defaultTenantId();
    const accepted = await invitePerson(token, 'ed@acme.test', 'editor', acme);
    expect(accepted.res.status).toBe(201);
    expect(accepted.res.body.data.access_token).toBeUndefined();
    expect(accepted.res.body.data.two_factor.step).toBe('setup');
  });
});

describe('admin reset', () => {
  test('lost phone: an admin resets it, the person is signed out and told; not yourself, not without 2FA', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();
    const ed = await invitePerson(token, 'ed@acme.test', 'editor', acme);
    const edToken = ed.tokens.access_token;
    const edId = (await call('GET', '/me', { token: edToken })).body.data.user.id;
    const ownerId = (await call('GET', '/me', { token })).body.data.user.id;

    expect((await call('POST', `/org/people/${edId}/two-factor/reset`, { token })).status).toBe(409); // nothing to reset
    await enable(edToken, PASSWORD);
    const directory = (await call('GET', '/org/people', { token })).body.data.people;
    expect(directory.find((p: { email: string }) => p.email === 'ed@acme.test').two_factor).toBe(true);
    expect(directory.find((p: { email: string }) => p.email === OWNER.email).two_factor).toBe(false);

    expect((await call('POST', `/org/people/${ownerId}/two-factor/reset`, { token })).status).toBe(403); // yourself
    expect((await call('POST', `/org/people/${edId}/two-factor/reset`, { token: edToken })).status).toBe(403); // no permission

    const reset = await call('POST', `/org/people/${edId}/two-factor/reset`, { token });
    expect(reset.status).toBe(200);
    expect((await call('GET', '/me', { token: edToken })).body.error?.code).toBe('SESSION_EXPIRED');
    expect((await outboxEmails()).at(-1)).toMatchObject({ to: 'ed@acme.test', subject: 'Your two-factor sign-in was reset' });
    expect(await actions()).toContain('user.two_factor_reset');
    expect((await signIn('ed@acme.test', PASSWORD)).data.access_token).toBeString();
  });
});
