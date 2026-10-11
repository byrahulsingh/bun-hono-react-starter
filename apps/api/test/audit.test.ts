import { beforeEach, describe, expect, test } from 'bun:test';

import { acceptNew, call, defaultTenantId, inviteToken, resetDb, roleId, setupInstall } from './helpers';

beforeEach(resetDb);

type Entry = { id: string; action: string; actor_user_id: string | null; tenant_id: string | null; target_id: string | null; changes: any };

async function audit(token: string, query = '') {
  return call<{ entries: Entry[]; refs: any; next: string | null }>('GET', `/audit${query}`, { token });
}

describe('audit log', () => {
  test('newest first, with names for the ids', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const beta = await call('POST', '/tenants', { token, body: { name: 'Beta' } });
    await call('PATCH', `/tenants/${beta.body.data.id}`, { token, body: { name: 'Beta Clients' } });

    const res = await audit(token);
    expect(res.status).toBe(200);
    expect(res.body.data!.entries.map((e) => e.action)).toEqual(['tenant.renamed', 'tenant.created', 'setup.completed']);
    const ownerId = res.body.data!.entries[0]!.actor_user_id!;
    expect(res.body.data!.refs.users[ownerId]).toEqual({ name: 'Asha Owner', email: 'owner@acme.test' });
    expect(res.body.data!.refs.tenants[beta.body.data.id]).toBe('Beta Clients');
    expect(res.body.data!.next).toBeNull();
  });

  test('pages with a cursor, without gaps or repeats', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    for (const name of ['A1', 'A2', 'A3', 'A4']) await call('POST', '/tenants', { token, body: { name } });

    const all = (await audit(token)).body.data!.entries.map((e) => e.id);
    expect(all).toHaveLength(5);
    const first = (await audit(token, '?limit=2')).body.data!;
    const second = (await audit(token, `?limit=2&before=${first.next}`)).body.data!;
    const third = (await audit(token, `?limit=2&before=${second.next}`)).body.data!;
    expect([...first.entries, ...second.entries, ...third.entries].map((e) => e.id)).toEqual(all);
    expect(third.next).toBeNull();
  });

  test('filters by category, tenant, person and time', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();
    await call('POST', '/tenants', { token, body: { name: 'Beta' } });
    await call('POST', `/t/${acme}/invitations`, { token, body: { email: 'ed@acme.test', role_id: await roleId('editor') } });
    const ed = await acceptNew(await inviteToken('ed@acme.test'), 'Ed');
    const edId = (await call('GET', '/me', { token: ed.tokens.access_token })).body.data.user.id;
    await call('PATCH', `/t/${acme}/members/${edId}`, { token, body: { role_id: await roleId('viewer') } });

    const tenantsOnly = (await audit(token, '?category=tenants')).body.data!.entries;
    expect(tenantsOnly.map((e) => e.action)).toEqual(['tenant.created']);

    const inAcme = (await audit(token, `?tenant=${acme}`)).body.data!.entries.map((e) => e.action);
    expect(inAcme).toEqual(['membership.role_changed', 'invitation.accepted', 'invitation.created']);

    // Ed: what he did (accepted) and what was done to him (role changed).
    const aboutEd = (await audit(token, `?actor=${edId}`)).body.data!.entries.map((e) => e.action);
    expect(aboutEd).toEqual(['membership.role_changed', 'invitation.accepted']);
    const roleChange = (await audit(token, `?actor=${edId}`)).body.data!;
    expect(roleChange.refs.roles[roleChange.entries[0]!.changes.to_role_id]).toBe('Viewer');

    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await audit(token, `?from=${encodeURIComponent(future)}`)).body.data!.entries).toEqual([]);
    expect((await audit(token, `?to=${encodeURIComponent(future)}`)).body.data!.entries.length).toBeGreaterThan(0);

    expect((await audit(token, '?category=everything')).status).toBe(422);
  });

  test('deleted roles keep their names in the history', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const role = await call('POST', '/roles', { token, body: { name: 'Temp', scope: 'tenant', permissions: ['projects.view'] } });
    await call('DELETE', `/roles/${role.body.data.id}`, { token });
    const page = (await audit(token, '?category=roles')).body.data!;
    expect(page.entries.map((e) => e.action)).toEqual(['role.deleted', 'role.created']);
    expect(page.refs.roles[role.body.data.id]).toBe('Temp');
  });

  test('only for org.audit.view; filter options list tenants and people', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();
    await call('POST', `/t/${acme}/invitations`, { token, body: { email: 'mo@acme.test', role_id: await roleId('manager') } });
    const mo = await acceptNew(await inviteToken('mo@acme.test'), 'Mo');
    expect((await audit(mo.tokens.access_token)).status).toBe(403);
    expect((await call('GET', '/audit/filters', { token: mo.tokens.access_token })).status).toBe(403);
    expect((await call('GET', '/audit')).status).toBe(401);

    await call('POST', '/invitations', { token, body: { email: 'ada@acme.test', role_id: await roleId('admin') } });
    const ada = await acceptNew(await inviteToken('ada@acme.test'), 'Ada');
    expect((await audit(ada.tokens.access_token)).status).toBe(200);

    const filters = (await call('GET', '/audit/filters', { token })).body.data;
    expect(filters.tenants.map((t: { name: string }) => t.name)).toEqual(['Acme']);
    expect(filters.people.map((p: { email: string }) => p.email).sort()).toEqual(['ada@acme.test', 'mo@acme.test', 'owner@acme.test']);
  });
});
