import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '#/db/db';
import { runMaintenance } from '#/modules/maintenance';
import { cleanUpIam, rotateSigningKeyIfDue } from '#/modules/iam';
import { resetSigningKeyCache } from '#/modules/iam/signing-keys';
import { cleanUpOutbox } from '#/modules/notifications';

import { call, login, resetDb, setupInstall } from './helpers';

beforeEach(resetDb);

const count = async (table: string) =>
  [...(await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))][0]!.n;

describe('maintenance', () => {
  test('deletes finished rows past their retention, keeps everything recent', async () => {
    const owner = await setupInstall();
    await login(); // a second, live session
    await call('POST', '/auth/logout', { token: owner.tokens.access_token, body: { scope: 'local' } });
    // The signed-out session ended long ago; one more ended yesterday (kept).
    await db.execute(sql`update iam.sessions set revoked_at = now() - interval '31 days' where revoked_at is not null`);
    const live = (await login()).tokens;
    const third = (await login()).tokens;
    await call('POST', '/auth/logout', { token: third.access_token, body: { scope: 'local' } });
    expect(await count('iam.sessions')).toBe(4);

    await db.execute(sql`insert into iam.rate_limits (key, count, window_start) values ('old', 1, now() - interval '2 days'), ('new', 1, now())`);
    await db.execute(sql`update iam.one_time_tokens set consumed_at = now() - interval '8 days'`); // the used setup link
    await db.execute(sql`insert into outbox (id, kind, payload, sent_at, created_at) values (gen_random_uuid(), 'email', null, now() - interval '8 days', now() - interval '8 days'), (gen_random_uuid(), 'email', null, now(), now())`);

    const iam = await cleanUpIam();
    expect(iam).toMatchObject({ sessions: 1, links: 1, rateLimits: 1 });
    expect(await count('iam.sessions')).toBe(3);
    expect(await count(`iam.rate_limits where key = 'new'`)).toBe(1);
    expect(await cleanUpOutbox()).toBe(1);
    // Live sessions still work; the recently ended one stays ended.
    expect((await call('GET', '/me', { token: live.access_token })).status).toBe(200);
    expect((await call('GET', '/me', { token: third.access_token })).status).toBe(401);
  });

  test('rotates the signing key when due; tokens signed before keep working', async () => {
    const owner = await setupInstall();
    expect(await rotateSigningKeyIfDue()).toBe(false);

    await db.execute(sql`update iam.signing_keys set activated_at = now() - interval '31 days'`);
    expect(await rotateSigningKeyIfDue()).toBe(true);
    resetSigningKeyCache();
    const keys = [...(await db.execute<{ retired: boolean }>(sql`select retired_at is not null as retired from iam.signing_keys order by activated_at`))];
    expect(keys.map((k) => k.retired)).toEqual([true, false]);

    // The old token (old key) still verifies; a new sign-in uses the new key.
    expect((await call('GET', '/me', { token: owner.tokens.access_token })).status).toBe(200);
    const fresh = await login();
    const kid = (t: string) => JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString()).kid;
    expect(kid(fresh.tokens.access_token)).not.toBe(kid(owner.tokens.access_token));

    // A retired key is deleted a week after retirement, not before.
    expect((await cleanUpIam()).signingKeys).toBe(0);
    await db.execute(sql`update iam.signing_keys set retired_at = now() - interval '8 days' where retired_at is not null`);
    expect((await cleanUpIam()).signingKeys).toBe(1);
  });

  test('one pass runs every task and reports what it did', async () => {
    await setupInstall();
    const result = await runMaintenance();
    expect(Object.keys(result)).toEqual(['signingKeyRotated', 'iam', 'outbox']);
    expect(result.signingKeyRotated).toBe(false);
  });
});
