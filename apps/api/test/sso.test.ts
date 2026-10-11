import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '#/db/db';
import { resetSessionCache } from '#/modules/iam/sessions';
import { base32Decode, stepAt, totpCode } from '#/modules/iam/totp';

import type { FakeIdp, Person, Trick } from './fake-idp';
import { CLIENT_ID, CLIENT_SECRET, startFakeIdp } from './fake-idp';
import {
  acceptNew,
  call,
  deviceKey,
  freshIp,
  inviteToken,
  login,
  OWNER,
  outboxEmails,
  resetDb,
  roleId,
  setupInstall,
} from './helpers';

let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp();
});
afterAll(() => idp.stop());
beforeEach(resetDb);

const PASSWORD = 'a long new password';
const ADMIN = 'ines@acme.test';

const actions = async () =>
  [...(await db.execute<{ action: string }>(sql`select action from audit_logs order by created_at`))].map((r) => r.action);
const lastAudit = async (action: string) =>
  [...(await db.execute<{ changes: any }>(sql`select changes from audit_logs where action = ${action} order by created_at desc limit 1`))][0]
    ?.changes;

/** Setup, plus an admin (password account) to sign in as. */
async function install() {
  const { tokens } = await setupInstall();
  const owner = tokens.access_token;
  await call('POST', '/invitations', { token: owner, body: { email: ADMIN, role_id: await roleId('admin') } });
  const admin = await acceptNew(await inviteToken(ADMIN), 'Ines Admin', PASSWORD);
  return { owner, admin: admin.tokens.access_token };
}

async function addConnection(token: string, overrides: Record<string, unknown> = {}) {
  return call('POST', '/settings/sso', {
    token,
    body: { name: 'Acme SSO', issuer: idp.issuer, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, domains: ['acme.test'], ...overrides },
  });
}

/** The whole trip: start, the provider's sign-in page, back with the code. */
async function ssoSignIn(person: Person, opts: { email?: string; trick?: Trick; finishWithOtherDevice?: boolean } = {}) {
  const device = await deviceKey();
  const start = await call('POST', '/auth/sso/start', {
    body: { email: opts.email ?? person.email, device_public_key: device.publicJwk },
    ip: freshIp(),
  });
  if (start.status !== 200) return { start, finish: start, state: '', code: '' };
  const { code, state } = idp.signIn(start.body.data.url, person, opts.trick);
  const finishDevice = opts.finishWithOtherDevice ? await deviceKey() : device;
  const finish = await call('POST', '/auth/sso/finish', { body: { state, code, device_public_key: finishDevice.publicJwk }, ip: freshIp() });
  return { start, finish, state, code, device };
}

/** A test sign-in from Settings; returns the result. */
async function testConnection(token: string, connectionId: string, person: Person) {
  const started = await call('POST', `/settings/sso/${connectionId}/test`, { token });
  const { code, state } = idp.signIn(started.body.data.url, person);
  return call('POST', '/settings/sso/test/finish', { token, body: { state, code } });
}

const ines: Person = { sub: 'idp-ines', email: ADMIN, email_verified: true, name: 'Ines from IdP' };

describe('setting up a connection', () => {
  test('owners only; checked against the provider before saving; the secret never comes back', async () => {
    const { owner, admin } = await install();
    expect((await addConnection(admin)).status).toBe(403);
    expect((await call('GET', '/settings/sso', { token: admin })).body.data.you_are_owner).toBe(false);

    const unreachable = await addConnection(owner, { issuer: 'http://localhost:1/nowhere' });
    expect(unreachable.body.error?.details?.issuer).toContain('could not be reached');
    const notHttps = await addConnection(owner, { issuer: 'http://idp.example.com' });
    expect(notHttps.body.error?.details?.issuer).toContain('https://');
    const publicDomain = await addConnection(owner, { domains: ['gmail.com'] });
    expect(publicDomain.body.error?.details?.domains).toContain('public email service');

    const created = await addConnection(owner, { domains: ['ACME.test', '@acme.test'] });
    expect(created.status).toBe(201);
    expect(created.body.data.domains).toEqual(['acme.test']);
    expect(JSON.stringify(created.body.data)).not.toContain(CLIENT_SECRET);

    const taken = await addConnection(owner, { name: 'Other' });
    expect(taken.body.error?.details?.domains).toBe('acme.test already belongs to another connection');

    const list = await call('GET', '/settings/sso', { token: owner });
    expect(list.body.data.redirect_uri).toMatch(/\/sso\/callback$/);
    expect(list.body.data.you_are_owner).toBe(true);
    expect(JSON.stringify(list.body.data)).not.toContain(CLIENT_SECRET);
    const [stored] = [...(await db.execute<{ s: Uint8Array }>(sql`select client_secret as s from iam.sso_connections`))];
    expect(Buffer.from(stored!.s).toString()).not.toContain(CLIENT_SECRET);
    expect(await actions()).toContain('sso.connection_created');
  });

  test('a test sign-in reports what the provider said, and what is wrong with it', async () => {
    const { owner } = await install();
    const id = (await addConnection(owner)).body.data.id;
    const outsider = await testConnection(owner, id, { sub: 'x', email: 'someone@elsewhere.test', email_verified: true });
    expect(outsider.body.data).toMatchObject({ ok: false, claims: { email: 'someone@elsewhere.test' } });
    expect(outsider.body.data.problem).toContain("not in this connection's domains");

    const good = await testConnection(owner, id, ines);
    expect(good.body.data).toMatchObject({ ok: true, problem: null, claims: { sub: 'idp-ines', email: ADMIN, name: 'Ines from IdP' } });
    expect((await call('GET', '/settings/sso', { token: owner })).body.data.connections[0].tested_at).not.toBeNull();
    // A test never signs anyone in or links anyone.
    expect([...(await db.execute(sql`select 1 from iam.sso_identities`))]).toHaveLength(0);
  });
});

describe('signing in', () => {
  test('first time: an existing account in the domain is linked; after that, the provider subject decides', async () => {
    const { owner } = await install();
    await addConnection(owner);

    const { finish } = await ssoSignIn(ines);
    expect(finish.status).toBe(200);
    const me = await call('GET', '/me', { token: finish.body.data.access_token });
    expect(me.body.data.user.email).toBe(ADMIN);
    const [session] = [...(await db.execute<{ auth_method: string; sso: string | null }>(sql`select auth_method, sso_connection_id as sso from iam.sessions order by created_at desc limit 1`))];
    expect(session).toMatchObject({ auth_method: 'sso' });
    expect(session!.sso).not.toBeNull();
    expect(await actions()).toEqual(expect.arrayContaining(['auth.sso_linked', 'auth.login']));
    expect(await lastAudit('auth.login')).toMatchObject({ method: 'sso', connection: 'Acme SSO' });

    // Same subject, another address in the domain: still Ines.
    const again = await ssoSignIn({ ...ines, email: 'ines.r@acme.test' });
    expect((await call('GET', '/me', { token: again.finish.body.data.access_token })).body.data.user.email).toBe(ADMIN);
  });

  test('no account: an open invitation makes one (no password) and is accepted; otherwise no entry', async () => {
    const { owner } = await install();
    await addConnection(owner);
    const nobody = await ssoSignIn({ sub: 'idp-zoe', email: 'zoe@acme.test', email_verified: true });
    expect(nobody.finish.status).toBe(403);
    expect(nobody.finish.body.message).toContain('Ask your admin for an invitation');
    expect(await lastAudit('auth.sso_failed')).toMatchObject({ reason: 'no account or invitation for zoe@acme.test' });

    await call('POST', '/invitations', { token: owner, body: { email: 'zoe@acme.test', role_id: await roleId('admin') } });
    const invited = await ssoSignIn({ sub: 'idp-zoe', email: 'zoe@acme.test', email_verified: true, name: 'Zoe Q' });
    expect(invited.finish.status).toBe(200);
    const me = await call('GET', '/me', { token: invited.finish.body.data.access_token });
    expect(me.body.data).toMatchObject({ user: { email: 'zoe@acme.test', name: 'Zoe Q' }, org_role: { key: 'admin' } });
    const [user] = [...(await db.execute<{ p: string | null }>(sql`select password_hash as p from iam.users where email = 'zoe@acme.test'`))];
    expect(user!.p).toBeNull();
    const [invite] = [...(await db.execute<{ status: string }>(sql`select status from invitations where email = 'zoe@acme.test'`))];
    expect(invite!.status).toBe('accepted');
    const methods = await call('GET', '/auth/sign-in-methods', { token: invited.finish.body.data.access_token });
    expect(methods.body.data).toEqual({ password: false, sso: ['Acme SSO'] });
  });

  test('the provider vouches only for its domains, and never for an unverified or missing email', async () => {
    const { owner } = await install();
    await addConnection(owner);
    // Starting needs an email in a connected domain.
    const elsewhere = await ssoSignIn({ sub: 'a', email: 'a@elsewhere.test' });
    expect(elsewhere.start.body.error?.details?.email).toContain("isn't set up for elsewhere.test");

    // Started with an acme address, but the provider answers for another domain.
    const swapped = await ssoSignIn({ sub: 'evil', email: OWNER.email.replace('acme.test', 'evil.test'), email_verified: true }, { email: ADMIN });
    expect(swapped.finish.status).toBe(403);
    const unverified = await ssoSignIn({ sub: 'u', email: ADMIN, email_verified: false });
    expect(unverified.finish.status).toBe(403);
    const noEmail = await ssoSignIn({ sub: 'n' }, { email: ADMIN });
    expect(noEmail.finish.status).toBe(403);
    expect([...(await db.execute(sql`select 1 from iam.sso_identities`))]).toHaveLength(0);
  });

  test('a token that does not check out is refused, every way', async () => {
    const { owner } = await install();
    await addConnection(owner);
    for (const trick of ['wrong_key', 'wrong_audience', 'wrong_issuer', 'wrong_nonce', 'expired', 'hs256', 'no_id_token'] as const) {
      const { finish } = await ssoSignIn(ines, { trick });
      expect({ trick, status: finish.status }).toEqual({ trick, status: 400 });
      expect(finish.body.message).toContain("Signing in with Acme SSO didn't work");
    }
    expect([...(await db.execute(sql`select 1 from iam.sessions where auth_method = 'sso'`))]).toHaveLength(0);
    expect((await actions()).filter((a) => a === 'auth.sso_failed')).toHaveLength(7);
  });

  test('the code must come back to the device that left, once, in time', async () => {
    const { owner } = await install();
    await addConnection(owner);
    const otherDevice = await ssoSignIn(ines, { finishWithOtherDevice: true });
    expect(otherDevice.finish.body.error?.code).toBe('LINK_INVALID');

    const ok = await ssoSignIn(ines);
    expect(ok.finish.status).toBe(200);
    const replay = await call('POST', '/auth/sso/finish', {
      body: { state: ok.state, code: ok.code, device_public_key: ok.device!.publicJwk },
      ip: freshIp(),
    });
    expect(replay.body.error?.code).toBe('LINK_INVALID');

    const device = await deviceKey();
    const start = await call('POST', '/auth/sso/start', { body: { email: ADMIN, device_public_key: device.publicJwk }, ip: freshIp() });
    const { code, state } = idp.signIn(start.body.data.url, ines);
    await db.execute(sql`update iam.sso_attempts set expires_at = now() - interval '1 second'`);
    const late = await call('POST', '/auth/sso/finish', { body: { state, code, device_public_key: device.publicJwk }, ip: freshIp() });
    expect(late.body.error?.code).toBe('LINK_INVALID');
  });

  test('two-factor is not asked on top; a deactivated account is refused', async () => {
    const { owner } = await install();
    await addConnection(owner);
    const { tokens } = await login(ADMIN, PASSWORD);
    const setup = await call('POST', '/auth/two-factor/setup', { token: tokens.access_token, body: { password: PASSWORD } });
    await call('POST', '/auth/two-factor/confirm', {
      token: tokens.access_token,
      body: { code: totpCode(base32Decode(setup.body.data.secret), stepAt(Date.now() / 1000)) },
    });
    const withTwoFactor = await ssoSignIn(ines);
    expect(withTwoFactor.finish.body.data.access_token).toBeString();

    await db.execute(sql`update iam.users set status = 'disabled' where email = ${ADMIN}`);
    const disabled = await ssoSignIn(ines);
    expect(disabled.finish.status).toBe(403);
    expect(disabled.finish.body.message).toContain('deactivated');
  });
});

describe('requiring SSO', () => {
  async function requiredSetup() {
    const env = await install();
    const id = (await addConnection(env.owner)).body.data.id as string;
    return { ...env, id };
  }

  test('only after a working test; then passwords stop working for everyone but owners', async () => {
    const { owner, admin, id } = await requiredSetup();
    const early = await call('PUT', `/settings/sso/${id}/required`, { token: owner, body: { required: true } });
    expect(early.body.error?.code).toBe('CONFLICT');
    expect((await testConnection(owner, id, ines)).body.data.ok).toBe(true);

    const on = await call('PUT', `/settings/sso/${id}/required`, { token: owner, body: { required: true } });
    expect(on.status).toBe(200);
    // Ines's password session (from accepting her invitation) ended; the owner's did not.
    expect(on.body.data.signed_out).toBeGreaterThanOrEqual(1);
    resetSessionCache();
    expect((await call('GET', '/me', { token: admin })).status).toBe(401);
    expect((await call('GET', '/me', { token: owner })).status).toBe(200);

    const password = await login(ADMIN, PASSWORD);
    expect(password.res.body.error?.code).toBe('SSO_REQUIRED');
    expect(password.res.status).toBe(403);
    // A wrong password still says only "incorrect": nothing about SSO before the password checks out.
    expect((await login(ADMIN, 'wrong password!!')).res.body.error?.code).toBe('INVALID_CREDENTIALS');
    // Owners keep their password, so a broken provider cannot lock everyone out.
    expect((await login()).res.status).toBe(200);
    expect((await ssoSignIn(ines)).finish.status).toBe(200);
    expect(await lastAudit('sso.required_changed')).toMatchObject({ from: false, to: true });
  });

  test('no way around it: reset emails, reset links, an admin reset, accepting with a password', async () => {
    const { owner, id } = await requiredSetup();
    // A reset link asked for before SSO was required.
    await call('POST', '/auth/forgot-password', { body: { email: ADMIN }, ip: freshIp() });
    const link = new URL((await outboxEmails()).at(-1)!.text.match(/https?:\/\/\S+reset-password\S+/)![0]).searchParams.get('token')!;
    await testConnection(owner, id, ines);
    await call('PUT', `/settings/sso/${id}/required`, { token: owner, body: { required: true } });

    const device = await deviceKey();
    const reset = await call('POST', '/auth/reset-password', { body: { token: link, password: 'another long password', device_public_key: device.publicJwk } });
    expect(reset.body.error?.code).toBe('SSO_REQUIRED');

    await db.execute(sql`delete from iam.rate_limits where key like 'forgot:email:%'`); // one request a minute per email
    await call('POST', '/auth/forgot-password', { body: { email: ADMIN }, ip: freshIp() });
    const mail = (await outboxEmails()).at(-1)!;
    expect(mail).toMatchObject({ to: ADMIN, subject: 'How to sign in' });
    expect(mail.text).not.toContain('reset-password');

    const [inesUser] = [...(await db.execute<{ id: string }>(sql`select id from iam.users where email = ${ADMIN}`))];
    const adminReset = await call('POST', `/org/people/${inesUser!.id}/password-reset`, { token: owner });
    expect(adminReset.body.message).toContain('single sign-on');

    await call('POST', '/invitations', { token: owner, body: { email: 'new@acme.test', role_id: await roleId('admin') } });
    const preview = await call('POST', '/invitations/preview', { body: { token: await inviteToken('new@acme.test') } });
    expect(preview.body.data.sso).toEqual({ name: 'Acme SSO', required: true });
    const accepted = await acceptNew(await inviteToken('new@acme.test'), 'New', PASSWORD);
    expect(accepted.res.body.error?.code).toBe('SSO_REQUIRED');
  });

  test('changing the provider needs a new test (required switches off); a new issuer drops the links', async () => {
    const { owner, id } = await requiredSetup();
    await testConnection(owner, id, ines);
    await call('PUT', `/settings/sso/${id}/required`, { token: owner, body: { required: true } });
    await ssoSignIn(ines);
    expect([...(await db.execute(sql`select 1 from iam.sso_identities`))]).toHaveLength(1);

    const renamed = await call('PUT', `/settings/sso/${id}`, {
      token: owner,
      body: { name: 'Acme Okta', issuer: idp.issuer, client_id: CLIENT_ID, domains: ['acme.test'] },
    });
    expect(renamed.body.data).toMatchObject({ name: 'Acme Okta', required: true });

    const newSecret = await call('PUT', `/settings/sso/${id}`, {
      token: owner,
      body: { name: 'Acme Okta', issuer: `${idp.issuer}/`, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, domains: ['acme.test'] },
    });
    expect(newSecret.body.data).toMatchObject({ required: false, tested_at: null });
    expect(await lastAudit('sso.connection_updated')).toMatchObject({ client_secret: 'replaced', required: { from: true, to: false } });
  });

  test('removing a connection signs out everyone it signed in', async () => {
    const { owner, id } = await requiredSetup();
    const { finish } = await ssoSignIn(ines);
    const token = finish.body.data.access_token;
    expect((await call('GET', '/me', { token })).status).toBe(200);
    expect((await call('DELETE', `/settings/sso/${id}`, { token: owner })).status).toBe(200);
    resetSessionCache();
    expect((await call('GET', '/me', { token })).status).toBe(401);
    expect([...(await db.execute(sql`select 1 from iam.sso_identities`))]).toHaveLength(0);
    expect(await lastAudit('sso.connection_deleted')).toMatchObject({ name: 'Acme SSO', signed_out: 1 });
    // And signing in with SSO is no longer offered.
    expect((await call('GET', '/auth/sso')).body.data.available).toBe(false);
  });
});
