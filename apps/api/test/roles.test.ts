import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '#/db/db';

import { acceptNew, call, defaultTenantId, inviteToken, resetDb, roleId, setupInstall } from './helpers';

beforeEach(resetDb);

async function createRole(token: string, body: Record<string, unknown>) {
  return call('POST', '/roles', { token, body });
}

/** Invites into the default tenant with a role id and accepts; returns their token. */
async function memberWith(byToken: string, tenantId: string, email: string, role_id: string) {
  const invited = await call('POST', `/t/${tenantId}/invitations`, { token: byToken, body: { email, role_id } });
  if (invited.status !== 201) throw new Error(`invite failed: ${JSON.stringify(invited.body)}`);
  const { tokens } = await acceptNew(await inviteToken(email));
  return tokens.access_token;
}

async function adminToken(ownerToken: string) {
  await call('POST', '/invitations', { token: ownerToken, body: { email: 'ada@acme.test', role_id: await roleId('admin') } });
  const { tokens } = await acceptNew(await inviteToken('ada@acme.test'), 'Ada');
  return tokens.access_token;
}

describe('role editor', () => {
  test('lists built-in roles with permissions, usage and the catalog; only for org.roles.manage', async () => {
    const owner = await setupInstall();
    const res = await call('GET', '/roles', { token: owner.tokens.access_token });
    expect(res.status).toBe(200);
    const { roles, catalog, held } = res.body.data;
    expect(roles.map((r: { name: string; scope: string }) => `${r.scope}:${r.name}`)).toEqual([
      'org:Owner',
      'org:Admin',
      'tenant:Manager',
      'tenant:Editor',
      'tenant:Viewer',
    ]);
    expect(roles[0]).toMatchObject({ is_system: true, usage: { people: 1, invitations: 0 } });
    expect(roles[0].permissions).toHaveLength(15);
    expect(catalog.modules.map((m: { key: string }) => m.key)).toEqual(['org', 'tenant', 'projects']);
    expect(catalog.permissions.find((p: { key: string }) => p.key === 'projects.edit')).toMatchObject({ requires: 'projects.view', scope: 'tenant' });
    expect(held).toHaveLength(15);

    const tenantId = await defaultTenantId();
    const manager = await memberWith(owner.tokens.access_token, tenantId, 'mo@acme.test', await roleId('manager'));
    expect((await call('GET', '/roles', { token: manager })).status).toBe(403);
  });

  test('a custom tenant role gets what it requires, is offered in tenants, and grants exactly that', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const created = await createRole(token, { name: 'Planner', description: 'Starts projects', scope: 'tenant', permissions: ['projects.create', 'tenant.users.view'] });
    expect(created.status).toBe(201);

    const tenantId = await defaultTenantId();
    const offered = await call('GET', `/t/${tenantId}/roles`, { token });
    expect(offered.body.data.map((r: { name: string }) => r.name)).toContain('Planner');

    const planner = await memberWith(token, tenantId, 'sam@acme.test', created.body.data.id);
    const perms = await call('GET', `/t/${tenantId}/permissions`, { token: planner });
    // projects.create requires projects.view, which was added for us.
    expect(perms.body.data).toEqual(['projects.create', 'projects.view', 'tenant.users.view']);

    const [audit] = [...(await db.execute<{ changes: { permissions: string[] } }>(sql`select changes from audit_logs where action = 'role.created'`))];
    expect(audit?.changes.permissions).toEqual(['projects.create', 'projects.view', 'tenant.users.view']);
  });

  test('refuses bad permission sets and names', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const orgPermOnTenantRole = await createRole(token, { name: 'X', scope: 'tenant', permissions: ['org.audit.view'] });
    expect(orgPermOnTenantRole.status).toBe(422);
    expect((await createRole(token, { name: 'X', scope: 'tenant', permissions: ['projects.fly'] })).status).toBe(422);
    expect((await createRole(token, { name: 'X', scope: 'tenant', permissions: [] })).body.error?.details).toEqual({ permissions: 'Choose at least one permission.' });
    const dup = await createRole(token, { name: 'manager', scope: 'tenant', permissions: ['projects.view'] });
    expect(dup.body.error?.details).toEqual({ name: 'A role with this name already exists.' });
    expect((await createRole(token, { name: 'X', scope: 'galaxy', permissions: ['projects.view'] })).status).toBe(422);
  });

  test('a custom org role applies in every tenant', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    await call('POST', '/tenants', { token, body: { name: 'Beta' } });
    const auditor = await createRole(token, { name: 'Auditor', scope: 'org', permissions: ['org.audit.view', 'projects.view'] });
    await call('POST', '/invitations', { token, body: { email: 'au@acme.test', role_id: auditor.body.data.id } });
    const { tokens } = await acceptNew(await inviteToken('au@acme.test'));
    const me = await call('GET', '/me', { token: tokens.access_token });
    expect(me.body.data.tenants).toHaveLength(2);
    expect(me.body.data.org_permissions).toEqual(['org.audit.view']);
    const perms = await call('GET', `/t/${me.body.data.tenants[1].id}/permissions`, { token: tokens.access_token });
    expect(perms.body.data).toEqual(['org.audit.view', 'projects.view']);
  });

  test('edits apply at once to everyone with the role; clearing the description works', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const tenantId = await defaultTenantId();
    const role = await createRole(token, { name: 'Reader', description: 'Reads', scope: 'tenant', permissions: ['projects.view'] });
    const reader = await memberWith(token, tenantId, 'rd@acme.test', role.body.data.id);

    const saved = await call('PATCH', `/roles/${role.body.data.id}`, {
      token,
      body: { name: 'Reader+', description: '', permissions: ['projects.edit', 'tenant.users.view'] },
    });
    expect(saved.status).toBe(200);
    expect((await call('GET', `/t/${tenantId}/permissions`, { token: reader })).body.data).toEqual(['projects.edit', 'projects.view', 'tenant.users.view']);
    const listed = (await call('GET', '/roles', { token })).body.data.roles.find((r: { id: string }) => r.id === role.body.data.id);
    expect(listed).toMatchObject({ name: 'Reader+', description: null, usage: { people: 1, invitations: 0 } });

    const [audit] = [...(await db.execute<{ changes: any }>(sql`select changes from audit_logs where action = 'role.updated'`))];
    expect(audit?.changes.permissions).toEqual({ added: ['projects.edit', 'tenant.users.view'], removed: [] });
  });

  test('built-in roles are locked; nobody edits or creates beyond their own access', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    expect((await call('PATCH', `/roles/${await roleId('viewer')}`, { token, body: { name: 'Lurker' } })).status).toBe(403);
    expect((await call('DELETE', `/roles/${await roleId('viewer')}`, { token })).status).toBe(403);

    const ada = await adminToken(token);
    // Admins lack billing: they cannot put it on a role...
    expect((await createRole(ada, { name: 'Payer', scope: 'org', permissions: ['org.billing.manage'] })).status).toBe(403);
    // ...nor touch a role that has it.
    const finance = await createRole(token, { name: 'Finance', scope: 'org', permissions: ['org.billing.manage'] });
    expect((await call('PATCH', `/roles/${finance.body.data.id}`, { token: ada, body: { name: 'Fin' } })).status).toBe(403);
    expect((await call('DELETE', `/roles/${finance.body.data.id}`, { token: ada })).status).toBe(403);
  });

  test('a role in use cannot be deleted; once free it goes, and cannot be handed out', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const tenantId = await defaultTenantId();
    const role = await createRole(token, { name: 'Temp', scope: 'tenant', permissions: ['projects.view'] });
    const id = role.body.data.id;

    const invite = await call('POST', `/t/${tenantId}/invitations`, { token, body: { email: 'tmp@acme.test', role_id: id } });
    const blocked = await call('DELETE', `/roles/${id}`, { token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain('1 open invitation uses it');

    await call('DELETE', `/t/${tenantId}/invitations/${invite.body.data.id}`, { token });
    expect((await call('DELETE', `/roles/${id}`, { token })).status).toBe(200);
    expect((await call('GET', '/roles', { token })).body.data.roles.some((r: { id: string }) => r.id === id)).toBe(false);
    expect((await call('POST', `/t/${tenantId}/invitations`, { token, body: { email: 'x@acme.test', role_id: id } })).status).toBe(422);
    // The name is free again.
    expect((await createRole(token, { name: 'Temp', scope: 'tenant', permissions: ['projects.view'] })).status).toBe(201);
  });
});
