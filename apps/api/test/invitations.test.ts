import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '#/db/db';

import { acceptNew, call, defaultTenantId, freshIp, inviteToken, resetDb, roleId, setupInstall } from './helpers';

beforeEach(resetDb);

describe('invitations', () => {
  test('owner invites an editor to a tenant; the editor gets exactly editor access there', async () => {
    const owner = await setupInstall();
    const tenantId = await defaultTenantId();

    const created = await call('POST', `/t/${tenantId}/invitations`, {
      token: owner.tokens.access_token,
      body: { email: 'Ravi@Acme.test', role_id: await roleId('editor') },
    });
    expect(created.status).toBe(201);

    const token = await inviteToken('ravi@acme.test');
    const preview = await call('POST', '/invitations/preview', { body: { token }, ip: freshIp() });
    expect(preview.body.data).toMatchObject({
      email: 'ravi@acme.test',
      organization_name: 'Acme',
      tenant_name: 'Acme',
      role_name: 'Editor',
      account_exists: false,
    });

    const { res, tokens } = await acceptNew(token, 'Ravi');
    expect(res.status).toBe(201);

    const me = await call('GET', '/me', { token: tokens.access_token });
    expect(me.body.data.org_role).toBeNull();
    expect(me.body.data.tenants).toEqual([{ id: tenantId, name: 'Acme', is_main: true, role: { id: expect.any(String), name: 'Editor' } }]);

    const perms = await call('GET', `/t/${tenantId}/permissions`, { token: tokens.access_token });
    expect(perms.body.data).toContain('projects.delete');
    expect(perms.body.data).not.toContain('tenant.users.manage');

    // An editor cannot invite people, here or at org level.
    const editorInvite = await call('POST', `/t/${tenantId}/invitations`, {
      token: tokens.access_token,
      body: { email: 'x@acme.test', role_id: await roleId('viewer') },
    });
    expect(editorInvite.status).toBe(403);
    const orgInvite = await call('POST', '/invitations', {
      token: tokens.access_token,
      body: { email: 'x@acme.test', role_id: await roleId('admin') },
    });
    expect(orgInvite.status).toBe(403);
  });

  test('a link works once; inviting again replaces the old link', async () => {
    const owner = await setupInstall();
    const tenantId = await defaultTenantId();
    const viewer = await roleId('viewer');
    const invite = () =>
      call('POST', `/t/${tenantId}/invitations`, {
        token: owner.tokens.access_token,
        body: { email: 'mia@acme.test', role_id: viewer },
      });

    await invite();
    const first = await inviteToken('mia@acme.test');
    await invite();
    const second = await inviteToken('mia@acme.test');
    expect(second).not.toBe(first);

    expect((await call('POST', '/invitations/preview', { body: { token: first }, ip: freshIp() })).body.error?.code).toBe('LINK_INVALID');
    expect((await acceptNew(second)).res.status).toBe(201);
    expect((await acceptNew(second)).res.body.error?.code).toBe('LINK_INVALID');
  });

  test('nobody can invite with more access than they have', async () => {
    const owner = await setupInstall();
    await call('POST', '/invitations', {
      token: owner.tokens.access_token,
      body: { email: 'admin@acme.test', role_id: await roleId('admin') },
    });
    const admin = await acceptNew(await inviteToken('admin@acme.test'), 'Ada Admin');
    expect(admin.res.status).toBe(201);

    // Admins lack billing, so they cannot create an owner.
    const res = await call('POST', '/invitations', {
      token: admin.tokens.access_token,
      body: { email: 'boss@acme.test', role_id: await roleId('owner') },
    });
    expect(res.status).toBe(403);

    // A tenant role on an org invite (or the reverse) is refused.
    const wrongScope = await call('POST', '/invitations', {
      token: owner.tokens.access_token,
      body: { email: 'x@acme.test', role_id: await roleId('editor') },
    });
    expect(wrongScope.status).toBe(422);
  });

  test('someone with an account accepts while signed in; a new-account accept is refused', async () => {
    const owner = await setupInstall();
    const tenantId = await defaultTenantId();
    const [second] = [...(await db.execute<{ id: string }>(sql`insert into tenants (id, name) values (gen_random_uuid(), 'Beta') returning id`))];

    await call('POST', `/t/${tenantId}/invitations`, {
      token: owner.tokens.access_token,
      body: { email: 'sam@acme.test', role_id: await roleId('viewer') },
    });
    const sam = await acceptNew(await inviteToken('sam@acme.test'), 'Sam');

    await call('POST', `/t/${second!.id}/invitations`, {
      token: owner.tokens.access_token,
      body: { email: 'sam@acme.test', role_id: await roleId('manager') },
    });
    const token = await inviteToken('sam@acme.test');
    expect((await call('POST', '/invitations/preview', { body: { token }, ip: freshIp() })).body.data.account_exists).toBe(true);
    expect((await acceptNew(token)).res.status).toBe(409);

    const signedIn = await call('POST', '/invitations/accept-signed-in', { token: sam.tokens.access_token, body: { token } });
    expect(signedIn.status).toBe(200);
    const me = await call('GET', '/me', { token: sam.tokens.access_token });
    expect(me.body.data.tenants.map((t: { name: string; role: { name: string } }) => `${t.name}:${t.role.name}`)).toEqual([
      'Acme:Viewer',
      'Beta:Manager',
    ]);
  });

  test('a tenant you are not in looks like it does not exist', async () => {
    const owner = await setupInstall();
    const tenantId = await defaultTenantId();
    const [other] = [...(await db.execute<{ id: string }>(sql`insert into tenants (id, name) values (gen_random_uuid(), 'Gamma') returning id`))];
    await call('POST', `/t/${tenantId}/invitations`, {
      token: owner.tokens.access_token,
      body: { email: 'vi@acme.test', role_id: await roleId('viewer') },
    });
    const vi = await acceptNew(await inviteToken('vi@acme.test'));

    expect((await call('GET', `/t/${other!.id}/permissions`, { token: vi.tokens.access_token })).status).toBe(404);
    expect((await call('GET', '/t/not-a-uuid/permissions', { token: vi.tokens.access_token })).status).toBe(404);
    // The owner sees every tenant.
    expect((await call('GET', `/t/${other!.id}/permissions`, { token: owner.tokens.access_token })).status).toBe(200);
  });

  test('an archived tenant keeps only view permissions', async () => {
    const owner = await setupInstall();
    const tenantId = await defaultTenantId();
    await db.execute(sql`update tenants set status = 'archived'`);
    const perms = await call('GET', `/t/${tenantId}/permissions`, { token: owner.tokens.access_token });
    expect(perms.body.data).toContain('projects.view');
    expect(perms.body.data).not.toContain('projects.create');
  });

  test('revoked invitations stop working and show in the list', async () => {
    const owner = await setupInstall();
    const created = await call('POST', '/invitations', {
      token: owner.tokens.access_token,
      body: { email: 'gone@acme.test', role_id: await roleId('admin') },
    });
    const token = await inviteToken('gone@acme.test');
    expect((await call('DELETE', `/invitations/${created.body.data.id}`, { token: owner.tokens.access_token })).status).toBe(200);
    expect((await acceptNew(token)).res.body.error?.code).toBe('LINK_INVALID');

    const list = await call('GET', '/invitations', { token: owner.tokens.access_token });
    expect(list.body.data[0]).toMatchObject({ email: 'gone@acme.test', status: 'revoked', role: { name: 'Admin' } });
  });
});
