import { sql } from 'drizzle-orm';
import type { CryptoKey } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import app from '#/app';
import { syncCatalog } from '#/db/catalog';
import { db } from '#/db/db';
import { base64url, decrypt, sha256 } from '#/libs/crypto';
import { issueSetupToken } from '#/modules/iam';
import { resetSessionCache } from '#/modules/iam/sessions';
import { resetSigningKeyCache } from '#/modules/iam/signing-keys';
import { withIam } from '#/db/db';
import { forgetBranding, getBranding } from '#/modules/branding';
import type { EmailContent } from '#/modules/notifications';
import { renderEmail } from '#/modules/notifications';
import { OUTBOX_PAYLOAD_CONTEXT } from '#/modules/notifications/outbox';
import type { EmailMessage } from '#/modules/providers/email';

/** Empties everything except the catalogs (lookups, permissions, built-in roles). */
export async function resetDb() {
  await db.execute(sql`
    truncate iam.sessions, iam.one_time_tokens, iam.rate_limits, iam.signing_keys,
             audit_logs, outbox, invitations, tenant_memberships, branding, brand_assets, tenants, organization, profiles cascade`);
  await db.execute(sql`truncate iam.users cascade`);
  // CASCADE also empties roles (they reference profiles via created_by), so
  // put the catalog back exactly as the migrate job would.
  await db.transaction((tx) => syncCatalog(tx));
  resetSessionCache();
  resetSigningKeyCache();
  forgetBranding();
}

/** A browser's device key: the private half never leaves the "browser". */
export async function deviceKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, publicJwk: { ...jwk, ext: true, key_ops: ['verify'] } };
}

export async function proof(privateKey: CryptoKey, refreshToken: string, iat?: number) {
  const jwt = new SignJWT({ th: base64url.encode(await sha256(refreshToken)) }).setProtectedHeader({
    alg: 'ES256',
    typ: 'refresh-proof',
  });
  return (iat ? jwt.setIssuedAt(iat) : jwt.setIssuedAt()).sign(privateKey);
}

let ipCounter = 1;
/** A fresh caller IP per test, so per-IP limits from other tests never interfere. */
export const freshIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

export interface CallResult<T = any> {
  status: number;
  body: { success: boolean; message: string; data?: T; error?: { code: string; details?: any } };
}

export async function call<T = any>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; ip?: string; userAgent?: string } = {},
): Promise<CallResult<T>> {
  const headers: Record<string, string> = { 'x-forwarded-for': options.ip ?? '10.255.0.1' };
  if (options.userAgent) headers['user-agent'] = options.userAgent;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const res = await app.fetch(
    new Request(`http://localhost/api${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
  return { status: res.status, body: (await res.json()) as CallResult<T>['body'] };
}

export const OWNER = { email: 'owner@acme.test', password: 'correct horse battery', name: 'Asha Owner' };

/** Runs setup and returns the owner's device and first token pair. */
export async function setupInstall() {
  const token = await withIam(issueSetupToken);
  const device = await deviceKey();
  const res = await call('POST', '/setup', {
    body: { token, organization_name: 'Acme', name: OWNER.name, email: OWNER.email, password: OWNER.password, device_public_key: device.publicJwk },
    ip: freshIp(),
  });
  if (res.status !== 201) throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
  return { device, tokens: res.body.data as { access_token: string; refresh_token: string } };
}

export async function login(email = OWNER.email, password = OWNER.password) {
  const device = await deviceKey();
  const res = await call('POST', '/auth/login', { body: { email, password, device_public_key: device.publicJwk }, ip: freshIp() });
  return { res, device, tokens: res.body.data as { access_token: string; refresh_token: string } };
}

/** Emails waiting in the outbox, decrypted and rendered as the worker would send them. */
export async function outboxEmails(): Promise<EmailMessage[]> {
  const rows = await db.execute<{ payload: Uint8Array }>(sql`select payload from outbox order by created_at`);
  const brand = await getBranding();
  return Promise.all(
    [...rows].map(async (r) => {
      const content = JSON.parse(new TextDecoder().decode(await decrypt(r.payload, OUTBOX_PAYLOAD_CONTEXT))) as EmailContent;
      return renderEmail(content, brand);
    }),
  );
}

// ─── Tenants and invitations ─────────────────────────────────────

export async function roleId(key: string): Promise<string> {
  const [row] = [...(await db.execute<{ id: string }>(sql`select id from roles where key = ${key}`))];
  return row!.id;
}

export async function defaultTenantId(): Promise<string> {
  const [row] = [...(await db.execute<{ id: string }>(sql`select id from tenants limit 1`))];
  return row!.id;
}

/** The raw token from the newest invitation email sent to `to`. */
export async function inviteToken(to: string): Promise<string> {
  const email = (await outboxEmails()).filter((e) => e.to === to).at(-1)!;
  return new URL(email.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
}

export async function acceptNew(token: string, name = 'New Person', password = 'a long new password') {
  const device = await deviceKey();
  const res = await call('POST', '/invitations/accept', {
    body: { token, name, password, device_public_key: device.publicJwk },
    ip: freshIp(),
  });
  return { res, tokens: res.body.data as { access_token: string } };
}
