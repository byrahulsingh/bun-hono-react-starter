import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db, withApp } from '#/db/db';
import { resetSessionCache } from '#/modules/iam/sessions';

import { call, deviceKey, freshIp, login, OWNER, outboxEmails, proof, resetDb, setupInstall } from './helpers';

beforeEach(resetDb);

describe('setup', () => {
  test('creates the organization, owner and default tenant once', async () => {
    expect((await call('GET', '/setup/status')).body.data).toEqual({ needs_setup: true });

    const device = await deviceKey();
    const wrong = await call('POST', '/setup', {
      body: { token: 'not-the-token', organization_name: 'Acme', name: 'A', email: 'a@acme.test', password: 'long enough pw', device_public_key: device.publicJwk },
      ip: freshIp(),
    });
    expect(wrong.status).toBe(410);
    expect(wrong.body.error?.code).toBe('LINK_INVALID');

    const { tokens } = await setupInstall();
    expect(tokens.access_token).toBeString();
    expect((await call('GET', '/setup/status')).body.data).toEqual({ needs_setup: false });

    const me = await call('GET', '/me', { token: tokens.access_token });
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(OWNER.email);
    expect(me.body.data.org_role.key).toBe('owner');
    expect(me.body.data.org_permissions).toContain('org.billing.manage');
    // The tenant setup creates is the organization's own: the main one.
    expect(me.body.data.tenants).toEqual([{ id: expect.any(String), name: 'Acme', is_main: true, role: null }]);
  });

  test('cannot run a second time', async () => {
    await setupInstall();
    const device = await deviceKey();
    const again = await call('POST', '/setup', {
      body: { token: 'x', organization_name: 'Other', name: 'B', email: 'b@acme.test', password: 'long enough pw', device_public_key: device.publicJwk },
      ip: freshIp(),
    });
    expect(again.status).toBe(410);
    expect(again.body.error?.code).toBe('GONE');
  });
});

describe('login', () => {
  beforeEach(async () => {
    await setupInstall();
  });

  test('wrong password and unknown email get the same answer', async () => {
    const wrong = await login(OWNER.email, 'wrong password!');
    const unknown = await login('nobody@acme.test', 'wrong password!');
    for (const { res } of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.message).toBe('Email or password is incorrect.');
    }
  });

  test('email is matched case-insensitively', async () => {
    const { res } = await login('  OWNER@Acme.TEST ');
    expect(res.status).toBe(200);
  });

  test('locks the email after 5 failures, even with the right password', async () => {
    for (let i = 0; i < 5; i++) await login(OWNER.email, 'wrong password!');
    const { res } = await login();
    expect(res.status).toBe(429);
    expect(res.body.error?.code).toBe('RATE_LIMITED');
  });

  test('refuses a device key that includes the private part', async () => {
    const res = await call('POST', '/auth/login', {
      body: { email: OWNER.email, password: OWNER.password, device_public_key: { kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43), d: 'c'.repeat(43) } },
      ip: freshIp(),
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.details?.['device_public_key.d']).toBeString();
  });

  test('a disabled user cannot sign in, and their tokens stop working', async () => {
    const { tokens } = await login();
    await db.execute(sql`update iam.users set status = 'disabled'`);
    resetSessionCache();
    expect((await call('GET', '/me', { token: tokens.access_token })).body.error?.code).toBe('SESSION_EXPIRED');
    expect((await login()).res.body.error?.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('refresh', () => {
  test('rotates: each refresh token works once', async () => {
    const { device, tokens } = await setupInstall();
    const r1 = await call('POST', '/auth/refresh', { body: { refresh_token: tokens.refresh_token, proof: await proof(device.privateKey, tokens.refresh_token) } });
    expect(r1.status).toBe(200);
    expect(r1.body.data.refresh_token).not.toBe(tokens.refresh_token);

    const r2 = await call('POST', '/auth/refresh', { body: { refresh_token: r1.body.data.refresh_token, proof: await proof(device.privateKey, r1.body.data.refresh_token) } });
    expect(r2.status).toBe(200);
    expect((await call('GET', '/me', { token: r2.body.data.access_token })).status).toBe(200);
  });

  test('one step behind (lost response, double reload) gets the current pair back', async () => {
    const { device, tokens } = await setupInstall();
    const r1 = await call('POST', '/auth/refresh', { body: { refresh_token: tokens.refresh_token, proof: await proof(device.privateKey, tokens.refresh_token) } });
    const again = await call('POST', '/auth/refresh', { body: { refresh_token: tokens.refresh_token, proof: await proof(device.privateKey, tokens.refresh_token) } });
    expect(again.status).toBe(200);
    expect(again.body.data.refresh_token).toBe(r1.body.data.refresh_token);
  });

  test('an older token is reuse: the whole session ends', async () => {
    const { device, tokens } = await setupInstall();
    let current = tokens.refresh_token;
    let access = tokens.access_token;
    for (let i = 0; i < 2; i++) {
      const r = await call('POST', '/auth/refresh', { body: { refresh_token: current, proof: await proof(device.privateKey, current) } });
      current = r.body.data.refresh_token;
      access = r.body.data.access_token;
    }
    const reused = await call('POST', '/auth/refresh', { body: { refresh_token: tokens.refresh_token, proof: await proof(device.privateKey, tokens.refresh_token) } });
    expect(reused.body.error?.code).toBe('REFRESH_TOKEN_REUSED');

    const latest = await call('POST', '/auth/refresh', { body: { refresh_token: current, proof: await proof(device.privateKey, current) } });
    expect(latest.body.error?.code).toBe('SESSION_EXPIRED');
    expect((await call('GET', '/me', { token: access })).body.error?.code).toBe('SESSION_EXPIRED');

    const audit = await db.execute<{ action: string }>(sql`select action from audit_logs where action = 'auth.token_revoked'`);
    expect([...audit]).toHaveLength(1);
  });

  test('a copied token without the device key is refused, and the session survives', async () => {
    const { device, tokens } = await setupInstall();
    const thief = await deviceKey();
    const stolen = await call('POST', '/auth/refresh', { body: { refresh_token: tokens.refresh_token, proof: await proof(thief.privateKey, tokens.refresh_token) } });
    expect(stolen.status).toBe(401);
    expect(stolen.body.error?.code).toBe('INVALID_DEVICE_PROOF');

    const owner = await call('POST', '/auth/refresh', { body: { refresh_token: tokens.refresh_token, proof: await proof(device.privateKey, tokens.refresh_token) } });
    expect(owner.status).toBe(200);
  });

  test('a proof made for another token, or too old, is refused', async () => {
    const { device, tokens } = await setupInstall();
    const otherToken = await call('POST', '/auth/refresh', { body: { refresh_token: tokens.refresh_token, proof: await proof(device.privateKey, 'some other token') } });
    expect(otherToken.body.error?.code).toBe('INVALID_DEVICE_PROOF');

    const old = await call('POST', '/auth/refresh', {
      body: { refresh_token: tokens.refresh_token, proof: await proof(device.privateKey, tokens.refresh_token, Math.floor(Date.now() / 1000) - 120) },
    });
    expect(old.body.error?.code).toBe('INVALID_DEVICE_PROOF');
  });

  test('a tampered token is refused', async () => {
    const { device, tokens } = await setupInstall();
    const t = tokens.refresh_token;
    const tampered = t.slice(0, -2) + (t.at(-2) === 'A' ? 'B' : 'A') + t.at(-1);
    const res = await call('POST', '/auth/refresh', { body: { refresh_token: tampered, proof: await proof(device.privateKey, tampered) } });
    expect(res.body.error?.code).toBe('SESSION_EXPIRED');
  });
});

describe('access token', () => {
  test('missing, forged or signed by someone else → UNAUTHORIZED', async () => {
    const { tokens } = await setupInstall();
    expect((await call('GET', '/me')).body.error?.code).toBe('UNAUTHORIZED');
    const [h, p] = tokens.access_token.split('.');
    expect((await call('GET', '/me', { token: `${h}.${p}.AAAA` })).body.error?.code).toBe('UNAUTHORIZED');
  });
});

describe('logout', () => {
  test('local ends this session only; global ends all', async () => {
    const first = await setupInstall();
    const second = await login();

    const out = await call('POST', '/auth/logout', { token: first.tokens.access_token, body: {} });
    expect(out.status).toBe(200);
    expect((await call('GET', '/me', { token: first.tokens.access_token })).body.error?.code).toBe('SESSION_EXPIRED');
    expect((await call('GET', '/me', { token: second.tokens.access_token })).status).toBe(200);

    const third = await login();
    await call('POST', '/auth/logout', { token: third.tokens.access_token, body: { scope: 'global' } });
    resetSessionCache(); // other replicas would notice within the cache time
    expect((await call('GET', '/me', { token: second.tokens.access_token })).body.error?.code).toBe('SESSION_EXPIRED');
  });
});

describe('passwords', () => {
  test('change password: needs the current one, signs out other devices, sends a notice', async () => {
    const mine = await setupInstall();
    const other = await login();

    const wrong = await call('POST', '/auth/change-password', {
      token: mine.tokens.access_token,
      body: { current_password: 'not it at all', new_password: 'a brand new password' },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error?.details?.current_password).toBe('Incorrect password');

    const ok = await call('POST', '/auth/change-password', {
      token: mine.tokens.access_token,
      body: { current_password: OWNER.password, new_password: 'a brand new password' },
    });
    expect(ok.status).toBe(200);
    resetSessionCache();
    expect((await call('GET', '/me', { token: mine.tokens.access_token })).status).toBe(200);
    expect((await call('GET', '/me', { token: other.tokens.access_token })).body.error?.code).toBe('SESSION_EXPIRED');
    expect((await login(OWNER.email, 'a brand new password')).res.status).toBe(200);
    expect((await outboxEmails()).map((e) => e.subject)).toContain('Your password was changed');
  });

  test('forgot + reset: same answer for unknown emails; link works once; old sessions end', async () => {
    const before = await setupInstall();

    const unknown = await call('POST', '/auth/forgot-password', { body: { email: 'nobody@acme.test' }, ip: freshIp() });
    const known = await call('POST', '/auth/forgot-password', { body: { email: OWNER.email }, ip: freshIp() });
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(unknown.body.message).toBe(known.body.message);

    const emails = await outboxEmails();
    expect(emails).toHaveLength(1);
    const token = new URL(emails[0]!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

    const device = await deviceKey();
    const reset = await call('POST', '/auth/reset-password', { body: { token, password: 'my new secure password', device_public_key: device.publicJwk }, ip: freshIp() });
    expect(reset.status).toBe(200);
    expect((await call('GET', '/me', { token: reset.body.data.access_token })).status).toBe(200);
    expect((await call('GET', '/me', { token: before.tokens.access_token })).body.error?.code).toBe('SESSION_EXPIRED');

    const again = await call('POST', '/auth/reset-password', { body: { token, password: 'another new password', device_public_key: device.publicJwk }, ip: freshIp() });
    expect(again.body.error?.code).toBe('LINK_INVALID');
    expect((await login(OWNER.email, 'my new secure password')).res.status).toBe(200);
  });
});

describe('database roles', () => {
  test('product code (app_user) cannot read schema iam at all', async () => {
    await setupInstall();
    expect(withApp((tx) => tx.execute(sql`select password_hash from iam.users`))).rejects.toThrow();
  });

  test('the audit log cannot be edited', async () => {
    await setupInstall();
    expect(withApp((tx) => tx.execute(sql`update audit_logs set action = 'nothing happened'`))).rejects.toThrow();
  });
});
