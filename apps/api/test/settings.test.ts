import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import app from '#/app';
import { db } from '#/db/db';
import { sendDueEmails } from '#/modules/notifications';
import { memorySender, useEmailSender } from '#/modules/providers/email';

import {
  acceptNew,
  call,
  defaultTenantId,
  freshIp,
  inviteToken,
  OWNER,
  outboxEmails,
  resetDb,
  roleId,
  setupInstall,
} from './helpers';

const mail = memorySender();

beforeEach(async () => {
  await resetDb();
  mail.sent.length = 0;
  mail.failNext = 0;
  useEmailSender(mail);
});
afterAll(() => useEmailSender(null));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const SVG = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function upload(token: string, slot: string, bytes: Uint8Array, name = 'logo.png') {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type: 'image/png' }));
  const res = await app.fetch(
    new Request(`http://localhost/api/settings/branding/${slot}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '10.255.0.1' },
      body: form,
    }),
  );
  return { status: res.status, body: (await res.json()) as { data?: any; error?: { code: string; details?: any } } };
}

async function editor(ownerToken: string) {
  const acme = await defaultTenantId();
  await call('POST', `/t/${acme}/invitations`, { token: ownerToken, body: { email: 'ed@acme.test', role_id: await roleId('editor') } });
  return (await acceptNew(await inviteToken('ed@acme.test'), 'Ed')).tokens.access_token;
}

const actions = async () =>
  [...(await db.execute<{ action: string }>(sql`select action from audit_logs order by created_at`))].map((r) => r.action);

describe('organization settings', () => {
  test('renames the organization, not the Main tenant; only with org.settings.manage', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    expect((await call('GET', '/settings/general', { token })).body.data.name).toBe('Acme');

    expect((await call('PATCH', '/settings/general', { token, body: { name: '  Acme Group ' } })).status).toBe(200);
    expect((await call('GET', '/settings/general', { token })).body.data.name).toBe('Acme Group');
    const me = await call('GET', '/me', { token });
    expect(me.body.data.tenants[0]).toMatchObject({ name: 'Acme', is_main: true });
    expect(await actions()).toContain('organization.renamed');

    expect((await call('PATCH', '/settings/general', { token, body: { name: ' ' } })).status).toBe(422);
    const ed = await editor(token);
    expect((await call('GET', '/settings/general', { token: ed })).status).toBe(403);
    expect((await call('GET', '/settings/email', { token: ed })).status).toBe(403);
  });
});

describe('branding', () => {
  test('public defaults before anyone signs in; saved changes show at once', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const before = await call('GET', '/branding');
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ product_name: 'App', accent_color: null, logo: null, icon: null });

    const saved = await call('PATCH', '/settings/branding', { token, body: { product_name: 'Northwind', accent_color: '#2563EB' } });
    expect(saved.status).toBe(200);
    expect((await call('GET', '/branding')).body.data).toMatchObject({ product_name: 'Northwind', accent_color: '#2563eb' });

    const bad = await call('PATCH', '/settings/branding', { token, body: { accent_color: 'blue' } });
    expect(bad.body.error?.details).toEqual({ accent_color: 'Use a colour like #2563eb' });

    // An empty name goes back to the default.
    await call('PATCH', '/settings/branding', { token, body: { product_name: '' } });
    expect((await call('GET', '/branding')).body.data.product_name).toBe('App');
    expect((await actions()).filter((a) => a === 'branding.updated')).toHaveLength(2);
  });

  test('logo upload: checked by content, served cacheable and sandboxed, replaced and removed cleanly', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;

    const first = await upload(token, 'logo', PNG);
    expect(first.status).toBe(200);
    expect(first.body.data.logo.content_type).toBe('image/png');
    const firstId = first.body.data.logo.id;

    const res = await app.fetch(new Request(`http://localhost/api/branding/assets/${firstId}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // Everything else under /api stays uncacheable and same-origin.
    const other = await app.fetch(new Request('http://localhost/api/branding'));
    expect(other.headers.get('cache-control')).toBe('no-store');
    expect(other.headers.get('cross-origin-resource-policy')).toBe('same-origin');

    // An SVG is accepted, but opened directly it can run nothing.
    const svg = await upload(token, 'logo', SVG, 'logo.svg');
    expect(svg.body.data.logo.content_type).toBe('image/svg+xml');
    const svgRes = await app.fetch(new Request(`http://localhost/api/branding/assets/${svg.body.data.logo.id}`));
    expect(svgRes.headers.get('content-security-policy')).toContain('sandbox');
    // The replaced logo is gone.
    expect((await app.fetch(new Request(`http://localhost/api/branding/assets/${firstId}`))).status).toBe(404);

    // Not an image, whatever its name says; too large.
    const text = await upload(token, 'icon', new TextEncoder().encode('hello'), 'icon.png');
    expect(text.body.error?.details).toEqual({ file: 'Use a PNG, JPEG, WebP or SVG image.' });
    const big = new Uint8Array(600 * 1024);
    big.set(PNG);
    expect((await upload(token, 'icon', big)).status).toBe(413);

    const removed = await call('DELETE', '/settings/branding/logo', { token });
    expect(removed.body.data.logo).toBeNull();
    expect([...(await db.execute(sql`select id from brand_assets`))]).toHaveLength(0);
    expect((await call('DELETE', '/settings/branding/banner', { token })).status).toBe(422);
  });

  test('emails carry the branding: layout, logo, button colour and sender name', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    await call('PATCH', '/settings/branding', { token, body: { product_name: 'Northwind', accent_color: '#fde047' } });
    const logo = (await upload(token, 'logo', PNG)).body.data.logo.id;

    await call('POST', '/invitations', { token, body: { email: 'ada@acme.test', role_id: await roleId('admin') } });
    const email = (await outboxEmails()).at(-1)!;
    expect(email.text).toContain('Accept the invitation: http');
    expect(email.text).toContain('— Northwind');
    expect(email.html).toContain(`/api/branding/assets/${logo}`);
    expect(email.html).toContain('background:#fde047');
    expect(email.html).toContain('color:#000000'); // dark text on a light button

    await sendDueEmails();
    expect(mail.sent.at(-1)).toMatchObject({ to: 'ada@acme.test', fromName: 'Northwind' });
  });
});

describe('email health', () => {
  test('shows the setup without the password; a test email goes out now and is remembered', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;

    const settings = await call('GET', '/settings/email', { token });
    expect(settings.body.data.config).toMatchObject({ source: 'development', host: 'localhost' });
    expect(JSON.stringify(settings.body.data.config)).not.toContain('password"');
    expect(settings.body.data.checked_at).toBeNull();

    mail.failNext = 1;
    const failed = await call('POST', '/settings/email/test', { token });
    expect(failed.status).toBe(503);
    expect(failed.body.message).toContain('simulated failure');
    expect((await call('GET', '/settings/email', { token })).body.data.checked_at).toBeNull();

    const sent = await call('POST', '/settings/email/test', { token });
    expect(sent.status).toBe(200);
    expect(mail.sent.at(-1)).toMatchObject({ to: OWNER.email, subject: 'Test email from App' });
    expect((await call('GET', '/settings/email', { token })).body.data.checked_at).not.toBeNull();
    expect(await actions()).toContain('email.test_sent');
  });

  test('lists failed and delayed emails; the warning clears once email works again', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    await call('POST', '/auth/forgot-password', { body: { email: OWNER.email }, ip: freshIp() });
    await call('POST', '/invitations', { token, body: { email: 'ada@acme.test', role_id: await roleId('admin') } });

    // The reset email gave up; the invitation is retrying.
    await db.execute(sql`update outbox set failed_at = now(), attempts = 8, last_error = 'Invalid login: 535 Authentication failed', payload = null where subject = 'Reset your password'`);
    await db.execute(sql`update outbox set attempts = 3, last_error = 'Connection timeout', run_after = now() + interval '2 minutes' where recipient = 'ada@acme.test'`);

    expect((await call('GET', '/settings/email/status', { token })).body.data).toEqual({ failing: 1, delayed: 1 });
    const data = (await call('GET', '/settings/email', { token })).body.data;
    expect(data.failed).toEqual([expect.objectContaining({ recipient: OWNER.email, subject: 'Reset your password', last_error: 'Invalid login: 535 Authentication failed' })]);
    expect(data.delayed).toEqual([expect.objectContaining({ recipient: 'ada@acme.test', attempts: 3 })]);

    // Mail flows again: the invitation goes out, the old failure stays listed but no longer warns.
    await db.execute(sql`update outbox set run_after = now() where recipient = 'ada@acme.test'`);
    await sendDueEmails();
    expect((await call('GET', '/settings/email/status', { token })).body.data).toEqual({ failing: 0, delayed: 0 });
    expect((await call('GET', '/settings/email', { token })).body.data.failed).toHaveLength(1);

    // A new failure warns again; a successful test email clears it.
    await db.execute(sql`update outbox set failed_at = now() where subject = 'Reset your password'`);
    expect((await call('GET', '/settings/email/status', { token })).body.data.failing).toBe(1);
    await call('POST', '/settings/email/test', { token });
    expect((await call('GET', '/settings/email/status', { token })).body.data.failing).toBe(0);
  });
});

describe('getting started', () => {
  test('each step ticks itself off; the checklist completes, or anyone can hide it for all', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const status = async () => (await call('GET', '/settings/onboarding', { token })).body.data;

    let s = await status();
    expect(s).toMatchObject({ dismissed: false, complete: false });
    expect(s.steps.map((step: { key: string; done: boolean }) => `${step.key}:${step.done}`)).toEqual([
      'branding:false',
      'email:false',
      'team:false',
      'tenant:false',
    ]);

    await call('PATCH', '/settings/branding', { token, body: { product_name: 'Northwind' } });
    await call('POST', '/settings/email/test', { token });
    await call('POST', '/invitations', { token, body: { email: 'ada@acme.test', role_id: await roleId('admin') } });
    s = await status();
    expect(s.complete).toBe(true); // the extra tenant is optional
    expect(s.steps.find((step: { key: string }) => step.key === 'tenant')).toMatchObject({ done: false, optional: true });

    // Revoking the only invitation un-ticks "invite your team".
    const invitation = (await call('GET', '/invitations', { token })).body.data[0].id;
    await call('DELETE', `/invitations/${invitation}`, { token });
    expect((await status()).complete).toBe(false);

    expect((await call('POST', '/settings/onboarding/dismiss', { token })).status).toBe(200);
    expect((await status()).dismissed).toBe(true);
  });
});

describe('bulk invitations', () => {
  test('each address on its own: sent, resent, skipped with the reason, invalid; duplicates once', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    const acme = await defaultTenantId();
    await editor(token); // ed@acme.test is a member already
    await call('POST', `/t/${acme}/invitations`, { token, body: { email: 'bo@acme.test', role_id: await roleId('viewer') } });

    const res = await call('POST', `/t/${acme}/invitations/bulk`, {
      token,
      body: {
        emails: ['amy@acme.test', 'BO@acme.test', 'ed@acme.test', 'owner@acme.test', 'not-an-email', 'Amy@Acme.test '],
        role_id: await roleId('viewer'),
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { email: 'amy@acme.test', status: 'sent' },
      { email: 'bo@acme.test', status: 'resent' },
      { email: 'ed@acme.test', status: 'skipped', message: 'Already a member of this tenant.' },
      { email: 'owner@acme.test', status: 'skipped', message: 'Already has access to every tenant through their organization role.' },
      { email: 'not-an-email', status: 'invalid', message: 'Not an email address' },
    ]);
    const pending = (await call('GET', `/t/${acme}/invitations`, { token })).body.data.filter((i: { status: string }) => i.status === 'pending');
    expect(pending.map((i: { email: string }) => i.email).sort()).toEqual(['amy@acme.test', 'bo@acme.test']);
  });

  test('a role the inviter may not hand out stops the whole batch before anything is sent', async () => {
    const owner = await setupInstall();
    const token = owner.tokens.access_token;
    // An admin (no billing) cannot hand out Owner.
    await call('POST', '/invitations', { token, body: { email: 'ada@acme.test', role_id: await roleId('admin') } });
    const ada = (await acceptNew(await inviteToken('ada@acme.test'), 'Ada')).tokens.access_token;
    const before = (await outboxEmails()).length;

    const refused = await call('POST', '/invitations/bulk', { token: ada, body: { emails: ['a@x.test', 'b@x.test'], role_id: await roleId('owner') } });
    expect(refused.status).toBe(403);
    const wrongLevel = await call('POST', '/invitations/bulk', { token, body: { emails: ['a@x.test'], role_id: await roleId('viewer') } });
    expect(wrongLevel.status).toBe(422);
    expect((await outboxEmails()).length).toBe(before);
    expect((await call('POST', '/invitations/bulk', { token, body: { emails: [], role_id: await roleId('admin') } })).status).toBe(422);
  });
});
