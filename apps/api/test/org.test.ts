import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { runBackfills } from '#/db/backfill';
import { db } from '#/db/db';

import { acceptNew, call, defaultTenantId, inviteToken, resetDb, roleId, setupInstall } from './helpers';

beforeEach(resetDb);

/** Invites `email` at org level as `roleKey` and accepts; returns their token and user id. */
async function addOrgPerson(byToken: string, email: string, roleKey: string, name: string) {
  const invited = await call('POST', '/invitations', { token: byToken, body: { email, role_id: await roleId(roleKey) } });
  if (invited.status !== 201) throw new Error(`invite failed: ${JSON.stringify(invited.body)}`);
  const { res, tokens } = await acceptNew(await inviteToken(email), name);
  if (res.status !== 201) throw new Error(`accept failed: ${JSON.stringify(res.body)}`);
  const me = await call('GET', '/me', { token: tokens.access_token });
  return { token: tokens.access_token, userId: me.body.data.user.id as string };
}

async function addTenantPerson(byToken: string, tenantId: string, email: string, roleKey: string, name: string) {
  await call('POST', `/t/${tenantId}/invitations`, { token: byToken, body: { email, role_id: await roleId(roleKey) } });
  const { tokens } = await acceptNew(await inviteToken(email), name);
  return { token: tokens.access_token };
}

const auditActions = async (prefix: string) =>
  [...(await db.execute<{ action: string }>(sql`select action from audit_logs where action like ${prefix + '%'} order by created_at`))].map(
    (r) => r.action,
  );

describe('managing tenants', () => {
  test('lists every tenant with member counts; only for org.tenants.manage', async () => {
    const owner = await setupInstall();
    const acme = await defaultTenantId();
    const manager = await addTenantPerson(owner.tokens.access_token, acme, 'mo@acme.test', 'manager', 'Mo');
    await call('POST', '/tenants', { token: owner.tokens.access_token, body: { name: 'beta' } });

    const list = await call('GET', '/tenants', { token: owner.tokens.access_token });
    expect(list.status).toBe(200);
    expect(list.body.data.map((t: { name: string; status: string; member_count: number }) => `${t.name}:${t.status}:${t.member_count}`)).toEqual([
      'Acme:active:1',
      'beta:active:0',
    ]);
    expect((await call('GET', '/tenants', { token: manager.token })).status).toBe(403);
  });

  test('rename: unique ignoring case, shows in /me, audited', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();
    await call('POST', '/tenants', { token, body: { name: 'Beta' } });

    const dup = await call('PATCH', `/tenants/${acme}`, { token, body: { name: 'BETA' } });
    expect(dup.status).toBe(422);
    expect(dup.body.error?.details).toEqual({ name: 'A tenant with this name already exists.' });
    // Changing only the case of its own name is fine.
    expect((await call('PATCH', `/tenants/${acme}`, { token, body: { name: 'ACME' } })).status).toBe(200);
    expect((await call('PATCH', `/tenants/${acme}`, { token, body: { name: 'Acme Studio' } })).status).toBe(200);
    const me = await call('GET', '/me', { token });
    expect(me.body.data.tenants.map((t: { name: string }) => t.name)).toEqual(['Acme Studio', 'Beta']);
    expect(await auditActions('tenant.renamed')).toHaveLength(2);
    expect((await call('PATCH', `/tenants/${Bun.randomUUIDv7()}`, { token, body: { name: 'X' } })).status).toBe(404);
  });

  test('archive hides a tenant and leaves view-only access; restore brings it back; never the main one', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();

    // The main tenant (the organization's own) is never archived.
    const main = await call('POST', `/tenants/${acme}/archive`, { token });
    expect(main.status).toBe(409);
    expect(main.body.message).toContain('main tenant');

    const beta = (await call('POST', '/tenants', { token, body: { name: 'Beta' } })).body.data.id;
    await call('POST', `/t/${beta}/invitations`, { token, body: { email: 'ed@acme.test', role_id: await roleId('editor') } });
    const { tokens } = await acceptNew(await inviteToken('ed@acme.test'), 'Ed');
    const editor = { token: tokens.access_token };

    expect((await call('POST', `/tenants/${beta}/archive`, { token })).status).toBe(200);
    expect((await call('GET', '/me', { token })).body.data.tenants.map((t: { name: string }) => t.name)).toEqual(['Acme']);
    expect((await call('GET', '/me', { token: editor.token })).body.data.tenants).toEqual([]);
    const perms = await call('GET', `/t/${beta}/permissions`, { token: editor.token });
    expect(perms.body.data).toEqual(['projects.view', 'tenant.users.view']);

    const list = await call('GET', '/tenants', { token });
    expect(list.body.data.map((t: { name: string; status: string; is_main: boolean }) => `${t.name}:${t.status}:${t.is_main}`)).toEqual([
      'Acme:active:true',
      'Beta:archived:false',
    ]);

    expect((await call('POST', `/tenants/${beta}/restore`, { token })).status).toBe(200);
    expect((await call('GET', '/me', { token: editor.token })).body.data.tenants).toHaveLength(1);
    expect(await auditActions('tenant.')).toEqual(['tenant.created', 'tenant.archived', 'tenant.restored']);
  });

  test('the main tenant is listed first, whatever its name', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    await call('POST', '/tenants', { token, body: { name: 'Aardvark Clients' } });
    const me = await call('GET', '/me', { token });
    expect(me.body.data.tenants.map((t: { name: string; is_main: boolean }) => `${t.name}:${t.is_main}`)).toEqual(['Acme:true', 'Aardvark Clients:false']);
  });

  test('existing installs get their main tenant marked by the migrate step', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();
    await call('POST', '/tenants', { token, body: { name: 'Aardvark' } });
    // As if the install predates the column.
    await db.execute(sql`update tenants set is_main = false`);
    const filled = await db.transaction((tx) => runBackfills(tx));
    expect(filled).toEqual({ mainTenant: acme });
    // Second run: nothing to do.
    expect(await db.transaction((tx) => runBackfills(tx))).toEqual({ mainTenant: null });
  });
});

describe('org admins', () => {
  test('lists people with an org role, with email, tenant count and last sign-in', async () => {
    const owner = await setupInstall();
    await addOrgPerson(owner.tokens.access_token, 'ada@acme.test', 'admin', 'Ada Admin');
    const list = await call('GET', '/org/members', { token: owner.tokens.access_token });
    expect(list.status).toBe(200);
    expect(list.body.data.map((m: { email: string; role: { key: string } }) => `${m.email}:${m.role.key}`)).toEqual([
      'ada@acme.test:admin',
      'owner@acme.test:owner',
    ]);
    expect(list.body.data[0]).toMatchObject({ tenant_count: 0, user_id: expect.any(String) });
    // Setup and invitation sign-ins count as sign-ins, not only the login form.
    expect(list.body.data.every((m: { last_login_at: string | null }) => m.last_login_at !== null)).toBe(true);
  });

  test('an owner promotes and demotes; an admin cannot touch owners or hand out owner', async () => {
    const owner = await setupInstall();
    const ada = await addOrgPerson(owner.tokens.access_token, 'ada@acme.test', 'admin', 'Ada');
    const ben = await addOrgPerson(owner.tokens.access_token, 'ben@acme.test', 'admin', 'Ben');
    const ownerId = (await call('GET', '/me', { token: owner.tokens.access_token })).body.data.user.id;

    const roles = await call('GET', '/org/roles', { token: ada.token });
    expect(roles.body.data.map((r: { name: string; assignable: boolean }) => `${r.name}:${r.assignable}`)).toEqual(['Owner:false', 'Admin:true']);

    expect((await call('PATCH', `/org/members/${ownerId}`, { token: ada.token, body: { role_id: await roleId('admin') } })).status).toBe(403);
    expect((await call('PATCH', `/org/members/${ben.userId}`, { token: ada.token, body: { role_id: await roleId('owner') } })).status).toBe(403);
    expect((await call('DELETE', `/org/members/${ada.userId}`, { token: ada.token })).status).toBe(403); // yourself
    expect((await call('PATCH', `/org/members/${ben.userId}`, { token: ada.token, body: { role_id: await roleId('editor') } })).status).toBe(422);

    const promoted = await call('PATCH', `/org/members/${ben.userId}`, { token: owner.tokens.access_token, body: { role_id: await roleId('owner') } });
    expect(promoted.status).toBe(200);
    expect((await call('GET', '/me', { token: ben.token })).body.data.org_role.key).toBe('owner');
    // Two owners now: Ben can demote the original owner.
    expect((await call('PATCH', `/org/members/${ownerId}`, { token: ben.token, body: { role_id: await roleId('admin') } })).status).toBe(200);
    expect(await auditActions('org_role.')).toEqual(['org_role.changed', 'org_role.changed']);
  });

  test('the organization always keeps an owner', async () => {
    const owner = await setupInstall();
    const ownerId = (await call('GET', '/me', { token: owner.tokens.access_token })).body.data.user.id;
    // A custom org role with every permission is the only one who could demote a sole owner.
    const [coOwner] = [...(await db.execute<{ id: string }>(sql`insert into roles (id, name, scope) values (gen_random_uuid(), 'Co-owner', 'org') returning id`))];
    await db.execute(sql`insert into role_permissions (role_id, permission_key) select ${coOwner!.id}, permission_key from role_permissions where role_id = (select id from roles where key = 'owner')`);
    const cara = await addOrgPerson(owner.tokens.access_token, 'cara@acme.test', 'admin', 'Cara');
    await db.execute(sql`update profiles set org_role_id = ${coOwner!.id} where id = ${cara.userId}`);

    const demote = await call('PATCH', `/org/members/${ownerId}`, { token: cara.token, body: { role_id: coOwner!.id } });
    expect(demote.status).toBe(409);
    expect(demote.body.message).toContain('at least one active owner');
    expect((await call('DELETE', `/org/members/${ownerId}`, { token: cara.token })).status).toBe(409);
  });

  test('removing an org role leaves tenant memberships; with none, the person has no tenants', async () => {
    const owner = await setupInstall();
    const ada = await addOrgPerson(owner.tokens.access_token, 'ada@acme.test', 'admin', 'Ada');
    expect((await call('GET', '/me', { token: ada.token })).body.data.tenants).toHaveLength(1);

    const removed = await call('DELETE', `/org/members/${ada.userId}`, { token: owner.tokens.access_token });
    expect(removed.status).toBe(200);
    const me = await call('GET', '/me', { token: ada.token });
    expect(me.body.data.org_role).toBeNull();
    expect(me.body.data.tenants).toEqual([]);
    expect((await call('GET', '/org/members', { token: ada.token })).status).toBe(403);
    // Already without an org role.
    expect((await call('DELETE', `/org/members/${ada.userId}`, { token: owner.tokens.access_token })).status).toBe(404);
    // And can be invited back at org level.
    const again = await call('POST', '/invitations', { token: owner.tokens.access_token, body: { email: 'ada@acme.test', role_id: await roleId('admin') } });
    expect(again.status).toBe(201);
  });
});
