/**
 * The example module. Besides the feature itself, these are the checks every
 * tenant feature needs: permissions per role, one tenant never reaching
 * another's rows, an archived tenant being read-only, and an audit trail.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '#/db/db';

import { acceptNew, call, defaultTenantId, inviteToken, resetDb, roleId, setupInstall } from './helpers';

beforeEach(resetDb);

async function memberWith(byToken: string, tenantId: string, email: string, roleKey: string) {
  const invited = await call('POST', `/t/${tenantId}/invitations`, { token: byToken, body: { email, role_id: await roleId(roleKey) } });
  if (invited.status !== 201) throw new Error(`invite failed: ${JSON.stringify(invited.body)}`);
  return (await acceptNew(await inviteToken(email))).tokens.access_token;
}

const actions = async () =>
  [...(await db.execute<{ action: string; changes: any }>(sql`select action, changes from audit_logs where action like 'project.%' order by id`))];

describe('projects', () => {
  test('an editor creates, renames, moves and deletes a project; each step is audited', async () => {
    const owner = (await setupInstall()).tokens.access_token;
    const tenantId = await defaultTenantId();
    const editor = await memberWith(owner, tenantId, 'ed@acme.test', 'editor');
    const base = `/t/${tenantId}/projects`;

    const created = await call('POST', base, { token: editor, body: { name: '  Website  ', description: 'The new site' } });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.name).toBe('Website');

    const listed = await call('GET', base, { token: editor });
    expect(listed.body.data).toEqual([
      expect.objectContaining({ id, name: 'Website', description: 'The new site', status: 'active', created_by: { id: expect.any(String), name: 'New Person' } }),
    ]);

    // Only what is sent changes.
    expect((await call('PATCH', `${base}/${id}`, { token: editor, body: { status: 'done' } })).status).toBe(200);
    expect((await call('PATCH', `${base}/${id}`, { token: editor, body: { name: 'Website v2', description: 'The new site' } })).status).toBe(200);
    const after = (await call('GET', base, { token: editor })).body.data[0];
    expect(after).toMatchObject({ name: 'Website v2', description: 'The new site', status: 'done' });

    expect((await call('DELETE', `${base}/${id}`, { token: editor })).status).toBe(200);
    expect((await call('GET', base, { token: editor })).body.data).toEqual([]);
    expect((await call('PATCH', `${base}/${id}`, { token: editor, body: { status: 'active' } })).status).toBe(404);

    expect(await actions()).toEqual([
      { action: 'project.created', changes: { project: 'Website' } },
      { action: 'project.updated', changes: { project: 'Website', status: { from: 'active', to: 'done' } } },
      // The unchanged description is not recorded.
      { action: 'project.updated', changes: { project: 'Website v2', name: { from: 'Website', to: 'Website v2' } } },
      { action: 'project.deleted', changes: { project: 'Website v2' } },
    ]);
  });

  test('names are unique within a tenant, ignoring case; another tenant may reuse one', async () => {
    const owner = (await setupInstall()).tokens.access_token;
    const acme = await defaultTenantId();
    const beta = (await call('POST', '/tenants', { token: owner, body: { name: 'Beta' } })).body.data.id;

    await call('POST', `/t/${acme}/projects`, { token: owner, body: { name: 'Website' } });
    const dup = await call('POST', `/t/${acme}/projects`, { token: owner, body: { name: 'WEBSITE' } });
    expect(dup.status).toBe(422);
    expect(dup.body.error?.details).toEqual({ name: 'A project with this name already exists here.' });
    expect((await call('POST', `/t/${beta}/projects`, { token: owner, body: { name: 'Website' } })).status).toBe(201);

    // Renaming onto a taken name is refused the same way.
    const other = (await call('POST', `/t/${acme}/projects`, { token: owner, body: { name: 'Shop' } })).body.data.id;
    const clash = await call('PATCH', `/t/${acme}/projects/${other}`, { token: owner, body: { name: 'website' } });
    expect(clash.body.error?.details).toEqual({ name: 'A project with this name already exists here.' });
  });

  test('checks the input', async () => {
    const owner = (await setupInstall()).tokens.access_token;
    const base = `/t/${await defaultTenantId()}/projects`;
    const blank = await call('POST', base, { token: owner, body: { name: '   ' } });
    expect(blank.status).toBe(422);
    expect(blank.body.error?.details).toEqual({ name: 'Required' });

    const id = (await call('POST', base, { token: owner, body: { name: 'Website' } })).body.data.id;
    expect((await call('PATCH', `${base}/${id}`, { token: owner, body: {} })).status).toBe(422);
    expect((await call('PATCH', `${base}/${id}`, { token: owner, body: { status: 'paused' } })).body.error?.details).toEqual({ status: 'Choose a status' });
    expect((await call('PATCH', `${base}/not-an-id`, { token: owner, body: { status: 'done' } })).status).toBe(422);
  });

  test('a viewer only reads; a stranger to the tenant gets nothing; ids from another tenant are not found', async () => {
    const owner = (await setupInstall()).tokens.access_token;
    const acme = await defaultTenantId();
    const beta = (await call('POST', '/tenants', { token: owner, body: { name: 'Beta' } })).body.data.id;
    const acmeProject = (await call('POST', `/t/${acme}/projects`, { token: owner, body: { name: 'Website' } })).body.data.id;

    const viewer = await memberWith(owner, acme, 'vi@acme.test', 'viewer');
    expect((await call('GET', `/t/${acme}/projects`, { token: viewer })).body.data).toHaveLength(1);
    expect((await call('POST', `/t/${acme}/projects`, { token: viewer, body: { name: 'Mine' } })).status).toBe(403);
    expect((await call('PATCH', `/t/${acme}/projects/${acmeProject}`, { token: viewer, body: { status: 'done' } })).status).toBe(403);
    expect((await call('DELETE', `/t/${acme}/projects/${acmeProject}`, { token: viewer })).status).toBe(403);

    // A manager of Beta cannot see Acme at all, and cannot reach Acme's project through Beta's URL.
    const betaManager = await memberWith(owner, beta, 'bm@acme.test', 'manager');
    expect((await call('GET', `/t/${acme}/projects`, { token: betaManager })).status).toBe(404);
    expect((await call('PATCH', `/t/${beta}/projects/${acmeProject}`, { token: betaManager, body: { name: 'Taken over' } })).status).toBe(404);
    expect((await call('DELETE', `/t/${beta}/projects/${acmeProject}`, { token: betaManager })).status).toBe(404);
    expect((await call('GET', `/t/${acme}/projects`, { token: owner })).body.data[0].name).toBe('Website');
  });

  test('an archived tenant is read-only', async () => {
    const owner = (await setupInstall()).tokens.access_token;
    const beta = (await call('POST', '/tenants', { token: owner, body: { name: 'Beta' } })).body.data.id;
    const id = (await call('POST', `/t/${beta}/projects`, { token: owner, body: { name: 'Website' } })).body.data.id;
    expect((await call('POST', `/tenants/${beta}/archive`, { token: owner })).status).toBe(200);

    expect((await call('GET', `/t/${beta}/projects`, { token: owner })).body.data).toHaveLength(1);
    expect((await call('POST', `/t/${beta}/projects`, { token: owner, body: { name: 'More' } })).status).toBe(403);
    expect((await call('PATCH', `/t/${beta}/projects/${id}`, { token: owner, body: { status: 'done' } })).status).toBe(403);
  });
});
