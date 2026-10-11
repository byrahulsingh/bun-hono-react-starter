import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '#/db/db';

import {
  acceptNew,
  call,
  defaultTenantId,
  deviceKey,
  freshIp,
  inviteToken,
  login,
  outboxEmails,
  resetDb,
  roleId,
  setupInstall,
} from './helpers';

beforeEach(resetDb);

const PASSWORD = 'a long new password';

async function tenantPerson(byToken: string, tenantId: string, email: string, roleKey: string, name: string) {
  await call('POST', `/t/${tenantId}/invitations`, { token: byToken, body: { email, role_id: await roleId(roleKey) } });
  const { tokens } = await acceptNew(await inviteToken(email), name, PASSWORD);
  const me = await call('GET', '/me', { token: tokens.access_token });
  return { token: tokens.access_token, userId: me.body.data.user.id as string };
}

async function orgPerson(byToken: string, email: string, roleKey: string, name: string) {
  await call('POST', '/invitations', { token: byToken, body: { email, role_id: await roleId(roleKey) } });
  const { tokens } = await acceptNew(await inviteToken(email), name, PASSWORD);
  const me = await call('GET', '/me', { token: tokens.access_token });
  return { token: tokens.access_token, userId: me.body.data.user.id as string };
}

const actions = async (prefix: string) =>
  [...(await db.execute<{ action: string }>(sql`select action from audit_logs where action like ${prefix + '%'} order by created_at`))].map((r) => r.action);

describe('people directory', () => {
  test('lists everyone with org role, tenants, status and last sign-in; only for org.users.manage', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();
    const ed = await tenantPerson(token, acme, 'ed@acme.test', 'editor', 'Ed');

    const res = await call('GET', '/org/people', { token });
    expect(res.status).toBe(200);
    const byEmail = Object.fromEntries(res.body.data.people.map((p: { email: string }) => [p.email, p]));
    expect(byEmail['owner@acme.test']).toMatchObject({ active: true, org_role: { key: 'owner' }, tenants: [] });
    expect(byEmail['ed@acme.test']).toMatchObject({ active: true, org_role: null, tenants: [{ name: 'Acme', archived: false, role: { name: 'Editor' } }] });
    expect(byEmail['ed@acme.test'].last_login_at).not.toBeNull();
    expect(res.body.data.tenants.map((t: { name: string }) => t.name)).toEqual(['Acme']);

    expect((await call('GET', '/org/people', { token: ed.token })).status).toBe(403);
  });

  test('deactivating ends every session and blocks sign-in; reactivating restores the same access', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();
    const ed = await tenantPerson(token, acme, 'ed@acme.test', 'editor', 'Ed');
    const edLaptop = await login('ed@acme.test', PASSWORD);

    expect((await call('POST', `/org/people/${ed.userId}/deactivate`, { token })).status).toBe(200);
    expect((await call('GET', '/me', { token: ed.token })).body.error?.code).toBe('SESSION_EXPIRED');
    expect((await call('GET', '/me', { token: edLaptop.tokens.access_token })).body.error?.code).toBe('SESSION_EXPIRED');
    expect((await login('ed@acme.test', PASSWORD)).res.body.error?.code).toBe('INVALID_CREDENTIALS');

    // Shown as deactivated, everywhere.
    const people = (await call('GET', '/org/people', { token })).body.data.people;
    expect(people.find((p: { email: string }) => p.email === 'ed@acme.test').active).toBe(false);
    const members = (await call('GET', `/t/${acme}/members`, { token })).body.data;
    expect(members.find((m: { email: string }) => m.email === 'ed@acme.test').active).toBe(false);

    // Forgot-password sends nothing; inviting the address is refused with a reason.
    const before = (await outboxEmails()).length;
    await call('POST', '/auth/forgot-password', { body: { email: 'ed@acme.test' }, ip: freshIp() });
    expect((await outboxEmails()).length).toBe(before);
    const invite = await call('POST', `/t/${acme}/invitations`, { token, body: { email: 'ed@acme.test', role_id: await roleId('viewer') } });
    expect(invite.body.error?.details).toEqual({ email: 'This account is deactivated. Reactivate it on the People page first.' });

    expect((await call('POST', `/org/people/${ed.userId}/reactivate`, { token })).status).toBe(200);
    const back = await login('ed@acme.test', PASSWORD);
    expect(back.res.status).toBe(200);
    const perms = await call('GET', `/t/${acme}/permissions`, { token: back.tokens.access_token });
    expect(perms.body.data).toContain('projects.delete');
    expect(await actions('user.')).toEqual(['user.deactivated', 'user.reactivated']);
  });

  test('not yourself, not someone above you, and never the last active owner', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const ownerId = (await call('GET', '/me', { token })).body.data.user.id;
    const ada = await orgPerson(token, 'ada@acme.test', 'admin', 'Ada');

    expect((await call('POST', `/org/people/${ownerId}/deactivate`, { token })).status).toBe(403); // yourself
    expect((await call('POST', `/org/people/${ownerId}/deactivate`, { token: ada.token })).status).toBe(403); // above Ada

    // Someone with every permission (a custom org role) still cannot switch off the only owner...
    const [coOwner] = [...(await db.execute<{ id: string }>(sql`insert into roles (id, name, scope) values (gen_random_uuid(), 'Co-owner', 'org') returning id`))];
    await db.execute(sql`insert into role_permissions (role_id, permission_key) select ${coOwner!.id}, permission_key from role_permissions where role_id = (select id from roles where key = 'owner')`);
    await db.execute(sql`update profiles set org_role_id = ${coOwner!.id} where id = ${ada.userId}`);
    expect((await call('POST', `/org/people/${ownerId}/deactivate`, { token: ada.token })).status).toBe(409);

    // ...and with a second owner who is deactivated, the first still counts as the last active one.
    const ben = await orgPerson(token, 'ben@acme.test', 'owner', 'Ben');
    expect((await call('POST', `/org/people/${ben.userId}/deactivate`, { token })).status).toBe(200);
    expect((await call('POST', `/org/people/${ownerId}/deactivate`, { token: ada.token })).status).toBe(409);
    const demote = await call('PATCH', `/org/members/${ownerId}`, { token: ada.token, body: { role_id: coOwner!.id } });
    expect(demote.status).toBe(409);
    expect(demote.body.message).toContain('active owner');
  });

  test('an admin can email someone a reset link; deactivation voids an open one', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const ed = await tenantPerson(token, await defaultTenantId(), 'ed@acme.test', 'editor', 'Ed');

    expect((await call('POST', `/org/people/${ed.userId}/password-reset`, { token })).status).toBe(200);
    const email = (await outboxEmails()).filter((e) => e.to === 'ed@acme.test').at(-1)!;
    expect(email.text).toContain('reset-password?token=');
    const resetToken = new URL(email.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
    expect(await actions('auth.password_reset_sent')).toHaveLength(1);

    await call('POST', `/org/people/${ed.userId}/deactivate`, { token });
    expect((await call('POST', `/org/people/${ed.userId}/password-reset`, { token })).status).toBe(409);
    await call('POST', `/org/people/${ed.userId}/reactivate`, { token });
    const device = await deviceKey();
    const used = await call('POST', '/auth/reset-password', { body: { token: resetToken, password: 'another long password', device_public_key: device.publicJwk }, ip: freshIp() });
    expect(used.body.error?.code).toBe('LINK_INVALID');
  });

  test('adds an existing person to another tenant directly, and tells them', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();
    const ed = await tenantPerson(token, acme, 'ed@acme.test', 'editor', 'Ed');
    const beta = (await call('POST', '/tenants', { token, body: { name: 'Beta' } })).body.data.id;
    const viewer = await roleId('viewer');

    const added = await call('POST', `/org/people/${ed.userId}/tenants`, { token, body: { tenant_id: beta, role_id: viewer } });
    expect(added.status).toBe(201);
    const me = await call('GET', '/me', { token: ed.token });
    expect(me.body.data.tenants.map((t: { name: string; role: { name: string } }) => `${t.name}:${t.role.name}`)).toEqual(['Acme:Editor', 'Beta:Viewer']);
    expect((await outboxEmails()).at(-1)).toMatchObject({ to: 'ed@acme.test', subject: 'You now have access to Beta' });
    expect(await actions('membership.added')).toHaveLength(1);

    const again = await call('POST', `/org/people/${ed.userId}/tenants`, { token, body: { tenant_id: beta, role_id: viewer } });
    expect(again.body.error?.details).toEqual({ tenant_id: 'Already a member of this tenant' });
    const ownerId = (await call('GET', '/me', { token })).body.data.user.id;
    expect((await call('POST', `/org/people/${ownerId}/tenants`, { token, body: { tenant_id: beta, role_id: viewer } })).status).toBe(409);
    expect((await call('POST', `/org/people/${ed.userId}/tenants`, { token, body: { tenant_id: beta, role_id: await roleId('admin') } })).status).toBe(422);

    await call('POST', `/tenants/${beta}/archive`, { token });
    const third = (await call('POST', '/tenants', { token, body: { name: 'Gamma' } })).body.data.id;
    await call('POST', `/tenants/${beta}/restore`, { token });
    await call('POST', `/org/people/${ed.userId}/deactivate`, { token });
    expect((await call('POST', `/org/people/${ed.userId}/tenants`, { token, body: { tenant_id: third, role_id: viewer } })).status).toBe(409);
  });
});
