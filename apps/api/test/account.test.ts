import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '#/db/db';

import { call, login, proof, resetDb, setupInstall } from './helpers';

beforeEach(resetDb);

describe('your devices', () => {
  test('lists live sessions, this one first and marked', async () => {
    const first = await setupInstall();
    const second = await login();

    const list = await call('GET', '/auth/sessions', { token: second.tokens.access_token });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.map((s: { current: boolean }) => s.current)).toEqual([true, false]);
    expect(list.body.data[0]).toMatchObject({ id: expect.any(String), ip: expect.any(String), created_at: expect.any(String), last_active_at: expect.any(String) });

    // Ended and idle-expired sessions are not listed.
    await call('POST', '/auth/logout', { token: first.tokens.access_token, body: { scope: 'local' } });
    const third = await login();
    await db.execute(sql`update iam.sessions set refreshed_at = now() - interval '30 days' where id <> (select id from iam.sessions where revoked_at is null order by created_at desc limit 1) and revoked_at is null`);
    const after = await call('GET', '/auth/sessions', { token: third.tokens.access_token });
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].current).toBe(true);
  });

  test('signing out another device ends it at once; not this one, not someone else’s', async () => {
    const laptop = await setupInstall();
    const phone = await login();
    const phoneSession = (await call('GET', '/auth/sessions', { token: phone.tokens.access_token })).body.data.find(
      (s: { current: boolean }) => s.current,
    ).id;

    const ended = await call('DELETE', `/auth/sessions/${phoneSession}`, { token: laptop.tokens.access_token });
    expect(ended.status).toBe(200);
    expect((await call('GET', '/me', { token: phone.tokens.access_token })).body.error?.code).toBe('SESSION_EXPIRED');
    const refresh = await call('POST', '/auth/refresh', {
      body: { refresh_token: phone.tokens.refresh_token, proof: await proof(phone.device.privateKey, phone.tokens.refresh_token) },
    });
    expect(refresh.status).toBe(401);

    // Again: already ended. A made-up id: the same answer.
    expect((await call('DELETE', `/auth/sessions/${phoneSession}`, { token: laptop.tokens.access_token })).status).toBe(404);
    expect((await call('DELETE', `/auth/sessions/${Bun.randomUUIDv7()}`, { token: laptop.tokens.access_token })).status).toBe(404);

    const mine = (await call('GET', '/auth/sessions', { token: laptop.tokens.access_token })).body.data[0].id;
    const self = await call('DELETE', `/auth/sessions/${mine}`, { token: laptop.tokens.access_token });
    expect(self.status).toBe(400);

    const [audit] = [...(await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_logs where action = 'auth.session_ended'`))];
    expect(audit?.n).toBe(1);
  });

  test('changing the password keeps this device and ends the others', async () => {
    const laptop = await setupInstall();
    const phone = await login();
    const changed = await call('POST', '/auth/change-password', {
      token: laptop.tokens.access_token,
      body: { current_password: 'correct horse battery', new_password: 'an even better password' },
    });
    expect(changed.status).toBe(200);
    const list = await call('GET', '/auth/sessions', { token: laptop.tokens.access_token });
    expect(list.body.data.map((s: { current: boolean }) => s.current)).toEqual([true]);
    expect((await call('GET', '/me', { token: phone.tokens.access_token })).status).toBe(401);
  });
});

describe('your profile', () => {
  test('changes your name, trimmed, and records it', async () => {
    const { tokens } = await setupInstall();
    const res = await call('PATCH', '/me', { token: tokens.access_token, body: { name: '  Asha K. Owner ' } });
    expect(res.status).toBe(200);
    expect((await call('GET', '/me', { token: tokens.access_token })).body.data.user.name).toBe('Asha K. Owner');

    const [audit] = [...(await db.execute<{ changes: unknown }>(sql`select changes from audit_logs where action = 'profile.updated'`))];
    expect(audit?.changes).toEqual({ name: { from: 'Asha Owner', to: 'Asha K. Owner' } });
  });

  test('refuses an empty name, and anyone signed out', async () => {
    const { tokens } = await setupInstall();
    const empty = await call('PATCH', '/me', { token: tokens.access_token, body: { name: '   ' } });
    expect(empty.status).toBe(422);
    expect(empty.body.error?.details).toEqual({ name: 'Required' });
    expect((await call('PATCH', '/me', { body: { name: 'X' } })).status).toBe(401);
  });
});
