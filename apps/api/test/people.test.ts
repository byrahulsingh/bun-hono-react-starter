import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db, isUniqueViolation } from '#/db/db';

import { acceptNew, call, defaultTenantId, inviteToken, resetDb, roleId, setupInstall } from './helpers';

beforeEach(resetDb);

/** Invites `email` into the tenant as `roleKey`, accepts as a new account, returns their access token. */
async function addPerson(byToken: string, tenantId: string, email: string, roleKey: string, name: string) {
  const invited = await call('POST', `/t/${tenantId}/invitations`, { token: byToken, body: { email, role_id: await roleId(roleKey) } });
  if (invited.status !== 201) throw new Error(`invite failed: ${JSON.stringify(invited.body)}`);
  const { res, tokens } = await acceptNew(await inviteToken(email), name);
  if (res.status !== 201) throw new Error(`accept failed: ${JSON.stringify(res.body)}`);
  const me = await call('GET', '/me', { token: tokens.access_token });
  return { token: tokens.access_token, userId: me.body.data.user.id as string };
}

describe('tenants', () => {
  test('an owner creates a tenant; names are unique ignoring case; it appears in /me', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;

    const created = await call('POST', '/tenants', { token, body: { name: '  Beta Recruiting ' } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ id: expect.any(String), name: 'Beta Recruiting' });

    const dup = await call('POST', '/tenants', { token, body: { name: 'beta recruiting' } });
    expect(dup.status).toBe(422);
    expect(dup.body.error?.details).toEqual({ name: 'A tenant with this name already exists.' });

    const me = await call('GET', '/me', { token });
    expect(me.body.data.tenants.map((t: { name: string }) => t.name)).toEqual(['Acme', 'Beta Recruiting']);

    const [audit] = [...(await db.execute<{ action: string }>(sql`select action from audit_logs where action = 'tenant.created'`))];
    expect(audit?.action).toBe('tenant.created');
  });

  test('if two creates race, the database index refuses the second (and we recognise it)', async () => {
    await setupInstall();
    const err = await db.execute(sql`insert into tenants (id, name) values (gen_random_uuid(), 'ACME')`).catch((e: unknown) => e);
    expect(isUniqueViolation(err, 'tenants_name_live')).toBe(true);
    expect(isUniqueViolation(err, 'some_other_index')).toBe(false);
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
  });

  test('only people with org.tenants.manage can create tenants', async () => {
    const owner = await setupInstall();
    const manager = await addPerson(owner.tokens.access_token, await defaultTenantId(), 'mo@acme.test', 'manager', 'Mo');
    const res = await call('POST', '/tenants', { token: manager.token, body: { name: 'Sneaky' } });
    expect(res.status).toBe(403);
    expect((await call('POST', '/tenants', { body: { name: 'Anon' } })).status).toBe(401);
  });

  test('a new tenant is empty: tenant members of another tenant cannot see it', async () => {
    const owner = await setupInstall();
    const acme = await defaultTenantId();
    const editor = await addPerson(owner.tokens.access_token, acme, 'ed@acme.test', 'editor', 'Ed');
    const beta = await call('POST', '/tenants', { token: owner.tokens.access_token, body: { name: 'Beta' } });

    expect((await call('GET', `/t/${beta.body.data.id}/permissions`, { token: editor.token })).status).toBe(404);
    const members = await call('GET', `/t/${beta.body.data.id}/members`, { token: owner.tokens.access_token });
    expect(members.body.data.map((m: { access: string }) => m.access)).toEqual(['org']);
  });
});

describe('people in a tenant', () => {
  test('lists org people and members with emails; viewers may not look', async () => {
    const owner = await setupInstall();
    const tenantId = await defaultTenantId();
    await addPerson(owner.tokens.access_token, tenantId, 'ed@acme.test', 'editor', 'Ed');
    const viewer = await addPerson(owner.tokens.access_token, tenantId, 'vi@acme.test', 'viewer', 'Vi');

    const list = await call('GET', `/t/${tenantId}/members`, { token: owner.tokens.access_token });
    expect(list.status).toBe(200);
    expect(list.body.data.map((m: { email: string; access: string; role: { name: string } }) => `${m.email}:${m.access}:${m.role.name}`)).toEqual([
      'owner@acme.test:org:Owner',
      'ed@acme.test:tenant:Editor',
      'vi@acme.test:tenant:Viewer',
    ]);

    expect((await call('GET', `/t/${tenantId}/members`, { token: viewer.token })).status).toBe(403);
  });

  test('a manager changes a role and removes someone; it applies at once', async () => {
    const owner = await setupInstall();
    const tenantId = await defaultTenantId();
    const manager = await addPerson(owner.tokens.access_token, tenantId, 'mo@acme.test', 'manager', 'Mo');
    const editor = await addPerson(manager.token, tenantId, 'ed@acme.test', 'editor', 'Ed');

    const changed = await call('PATCH', `/t/${tenantId}/members/${editor.userId}`, {
      token: manager.token,
      body: { role_id: await roleId('viewer') },
    });
    expect(changed.status).toBe(200);
    const perms = await call('GET', `/t/${tenantId}/permissions`, { token: editor.token });
    expect(perms.body.data).toEqual(['projects.view']);

    const removed = await call('DELETE', `/t/${tenantId}/members/${editor.userId}`, { token: manager.token });
    expect(removed.status).toBe(200);
    expect((await call('GET', `/t/${tenantId}/permissions`, { token: editor.token })).status).toBe(404);
    expect((await call('GET', '/me', { token: editor.token })).body.data.tenants).toEqual([]);

    // Removed people can be invited back.
    await call('POST', `/t/${tenantId}/invitations`, { token: manager.token, body: { email: 'ed@acme.test', role_id: await roleId('viewer') } });
    const back = await call('POST', '/invitations/accept-signed-in', { token: editor.token, body: { token: await inviteToken('ed@acme.test') } });
    expect(back.status).toBe(200);

    const actions = [...(await db.execute<{ action: string }>(sql`select action from audit_logs where action like 'membership.%' order by created_at`))];
    expect(actions.map((a) => a.action)).toEqual(['membership.role_changed', 'membership.removed']);
  });

  test('nobody changes themselves, org people, or anyone with more access', async () => {
    const owner = await setupInstall();
    const tenantId = await defaultTenantId();
    const manager = await addPerson(owner.tokens.access_token, tenantId, 'mo@acme.test', 'manager', 'Mo');
    const editor = await addPerson(owner.tokens.access_token, tenantId, 'ed@acme.test', 'editor', 'Ed');
    const ownerId = (await call('GET', '/me', { token: owner.tokens.access_token })).body.data.user.id;

    const self = await call('DELETE', `/t/${tenantId}/members/${manager.userId}`, { token: manager.token });
    expect(self.status).toBe(403);
    const org = await call('DELETE', `/t/${tenantId}/members/${ownerId}`, { token: manager.token });
    expect(org.status).toBe(404);

    // A custom "people coordinator" role: may manage people, but sees no projects.
    const [coordRole] = [
      ...(await db.execute<{ id: string }>(
        sql`insert into roles (id, name, scope) values (gen_random_uuid(), 'Coordinator', 'tenant') returning id`,
      )),
    ];
    await db.execute(
      sql`insert into role_permissions (role_id, permission_key) values (${coordRole!.id}, 'tenant.users.view'), (${coordRole!.id}, 'tenant.users.manage')`,
    );
    const coord = await addPerson(owner.tokens.access_token, tenantId, 'co@acme.test', 'viewer', 'Co');
    await db.execute(sql`update tenant_memberships set role_id = ${coordRole!.id} where user_id = ${coord.userId}`);

    const over = await call('DELETE', `/t/${tenantId}/members/${editor.userId}`, { token: coord.token });
    expect(over.status).toBe(403);
    const roles = await call('GET', `/t/${tenantId}/roles`, { token: coord.token });
    expect(roles.body.data.map((r: { name: string; assignable: boolean }) => `${r.name}:${r.assignable}`)).toEqual([
      'Manager:false',
      'Editor:false',
      'Coordinator:true',
      'Viewer:false',
    ]);
    // An editor cannot even list the roles: that is for people who can invite.
    expect((await call('GET', `/t/${tenantId}/roles`, { token: editor.token })).status).toBe(403);
  });

  test('inviting someone who already has access is refused, by field', async () => {
    const owner = await setupInstall();
    const tenantId = await defaultTenantId();
    await addPerson(owner.tokens.access_token, tenantId, 'ed@acme.test', 'editor', 'Ed');

    const member = await call('POST', `/t/${tenantId}/invitations`, {
      token: owner.tokens.access_token,
      body: { email: 'ed@acme.test', role_id: await roleId('viewer') },
    });
    expect(member.status).toBe(422);
    expect(member.body.error?.details).toEqual({ email: 'Already a member of this tenant.' });

    const orgPerson = await call('POST', `/t/${tenantId}/invitations`, {
      token: owner.tokens.access_token,
      body: { email: 'owner@acme.test', role_id: await roleId('viewer') },
    });
    expect(orgPerson.body.error?.details).toEqual({ email: 'Already has access to every tenant through their organization role.' });
  });
});
