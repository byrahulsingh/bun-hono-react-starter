/**
 * Single sign-on: what a sign-in through an OpenID Connect provider means for
 * accounts. The protocol itself is in oidc.ts.
 *
 *   start    the browser asks with a work email; the domain picks the
 *            connection; we remember the trip (sso_attempts) and send the
 *            browser to the provider
 *   finish   the browser brings the provider's code back from the device that
 *            started; we exchange it, check the ID token, and sign the person in
 *
 * Who it is, in order:
 *   1. an identity already linked (connection + the provider's `sub`)
 *   2. the first time: an existing account with that email, linked now. Only
 *      for the connection's own domains, and never when the provider says the
 *      email is unverified
 *   3. no account: the app's open invitations for that email (the hook), or no entry
 *
 * The provider vouches only for its connection's domains, every time. SSO
 * sign-ins skip our own two-factor step: the provider runs its own.
 */

import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { isUniqueViolation, withIam } from '#/db/db';
import { sessions, ssoAttempts, ssoConnections, ssoDomains, ssoIdentities, users } from '#/db/schema';
import { decrypt, encrypt, hashToken, randomToken, safeEqual } from '#/libs/crypto';
import { env } from '#/libs/env';
import { AppError } from '#/libs/errors';
import { logger } from '#/libs/logger';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';

import { AUTH, RATE_LIMITS, RETENTION } from './iam.config';
import type { AuthContext } from './iam.service';
import type { ssoConnectionSchema, ssoFinishSchema, ssoStartSchema, ssoTestFinishSchema } from './iam.validators';
import type { Discovery, IdTokenClaims } from './oidc';
import { OidcError, authorizationUrl, discover, exchangeCode, normalizeIssuer, pkcePair, verifyIdToken } from './oidc';
import { rateLimit } from './rate-limit';
import type { TokenPair } from './sessions';
import { createSession, revokeSession } from './sessions';
import { isUsableDeviceKey } from './tokens';
import { deviceKeyHash } from './two-factor';
import { findUserByEmail, getUser } from './users';

const SECRET_CONTEXT = 'iam.sso_connections.client_secret';
const VERIFIER_CONTEXT = 'iam.sso_attempts.code_verifier';

/** The one redirect URL for every connection: a client page, which hands the code to the API. */
export const ssoRedirectUri = () => `${env.APP_URL}/sso/callback`;

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1);
const fieldError = (field: string, message: string) => new AppError('VALIDATION', 'Some fields are invalid.', { [field]: message });

// ─── What the app decides (tenancy registers these; see configureSso) ──

export interface SsoHooks {
  /**
   * Someone signed in through SSO and has no account: create it from their
   * open invitations, inside this transaction. The new user id, or null when
   * nothing invites them.
   */
  provisionInvited: (tx: Tx, person: { email: string; name: string | null }, meta: RequestMeta) => Promise<string | null>;
  /** Who may still use a password where SSO is required (the owners), so a broken provider cannot lock everyone out. */
  mayUsePasswordAnyway: (tx: Tx, userId: string) => Promise<boolean>;
}

let hooks: SsoHooks = {
  provisionInvited: async () => null,
  mayUsePasswordAnyway: async () => false,
};

export function configureSso(next: SsoHooks) {
  hooks = next;
}

// ─── Lookups ─────────────────────────────────────────────────────

type Connection = typeof ssoConnections.$inferSelect;

async function connectionForDomain(tx: Tx, domain: string): Promise<Connection | undefined> {
  const [row] = await tx
    .select({ connection: ssoConnections })
    .from(ssoDomains)
    .innerJoin(ssoConnections, eq(ssoConnections.id, ssoDomains.connection_id))
    .where(eq(ssoDomains.domain, domain));
  return row?.connection;
}

async function domainsOf(tx: Tx, connectionId: string): Promise<string[]> {
  const rows = await tx.select({ domain: ssoDomains.domain }).from(ssoDomains).where(eq(ssoDomains.connection_id, connectionId));
  return rows.map((r) => r.domain).sort();
}

/** The connection that requires SSO for this email's domain, whoever the person is. */
export async function ssoRequiredForEmail(tx: Tx, email: string): Promise<{ name: string } | null> {
  const connection = await connectionForDomain(tx, domainOf(email));
  return connection?.required ? { name: connection.name } : null;
}

/** Password refused for this person: SSO is required for their domain and they are not exempt. */
export async function passwordRefusedFor(tx: Tx, user: { id: string; email: string }): Promise<{ name: string } | null> {
  const required = await ssoRequiredForEmail(tx, user.email);
  if (!required || (await hooks.mayUsePasswordAnyway(tx, user.id))) return null;
  return required;
}

export const ssoRequiredError = (name: string) =>
  new AppError('SSO_REQUIRED', `Your organization signs in with ${name}. Use "Sign in with SSO" instead of a password.`);

/** For an email's sign-in page or invitation: SSO set up for its domain, and whether it is required. */
export async function ssoForEmail(tx: Tx, email: string): Promise<{ name: string; required: boolean } | null> {
  const connection = await connectionForDomain(tx, domainOf(email));
  return connection ? { name: connection.name, required: connection.required } : null;
}

/** Whether to offer "Sign in with SSO" at all. */
export async function ssoAvailable(): Promise<boolean> {
  const [row] = await withIam((tx) => tx.select({ id: ssoConnections.id }).from(ssoConnections).limit(1));
  return Boolean(row);
}

// ─── Managing connections (the caller has checked who may: owners) ──

export interface SsoConnectionView {
  id: string;
  name: string;
  issuer: string;
  client_id: string;
  domains: string[];
  required: boolean;
  tested_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SsoSettings {
  /** What to register at the provider as the redirect (callback) URL. */
  redirect_uri: string;
  connections: SsoConnectionView[];
}

const view = (c: Connection, domains: string[]): SsoConnectionView => ({
  id: c.id,
  name: c.name,
  issuer: c.issuer,
  client_id: c.client_id,
  domains,
  required: c.required,
  tested_at: c.tested_at,
  created_at: c.created_at,
  updated_at: c.updated_at,
});

export async function listSsoConnections(): Promise<SsoSettings> {
  return withIam(async (tx) => {
    const rows = await tx.select().from(ssoConnections).orderBy(ssoConnections.created_at);
    return {
      redirect_uri: ssoRedirectUri(),
      connections: await Promise.all(rows.map(async (c) => view(c, await domainsOf(tx, c.id)))),
    };
  });
}

/** Free email services: a connection for one would vouch for strangers. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'zoho.com',
  'yandex.com',
  'mail.com',
  'rediffmail.com',
]);

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function cleanDomains(input: string[]): string[] {
  const domains = [...new Set(input.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  if (domains.length === 0) throw fieldError('domains', 'Add at least one domain');
  for (const domain of domains) {
    if (!DOMAIN.test(domain)) throw fieldError('domains', `"${domain}" is not a domain`);
    if (PUBLIC_EMAIL_DOMAINS.has(domain)) throw fieldError('domains', `${domain} is a public email service; use your organization's own domain`);
  }
  return domains.sort();
}

function cleanIssuer(value: string): string {
  const issuer = normalizeIssuer(value);
  if (!issuer) throw fieldError('issuer', 'Use the https:// address of your provider (http only for localhost)');
  return issuer;
}

async function replaceDomains(tx: Tx, connectionId: string, domains: string[]) {
  const [taken] = await tx
    .select({ domain: ssoDomains.domain })
    .from(ssoDomains)
    .where(and(inArray(ssoDomains.domain, domains), ne(ssoDomains.connection_id, connectionId)));
  if (taken) throw fieldError('domains', `${taken.domain} already belongs to another connection`);
  await tx.delete(ssoDomains).where(eq(ssoDomains.connection_id, connectionId));
  await tx.insert(ssoDomains).values(domains.map((domain) => ({ domain, connection_id: connectionId })));
}

/** Discovery must work before a connection is saved: a typo shows up now, not at someone's sign-in. */
async function assertDiscoverable(issuer: string): Promise<void> {
  try {
    await discover(issuer, { fresh: true });
  } catch (err) {
    if (err instanceof OidcError) throw fieldError('issuer', err.message);
    throw err;
  }
}

type ConnectionInput = z.infer<typeof ssoConnectionSchema>;

export async function createSsoConnection(actorId: string, input: ConnectionInput, meta: RequestMeta): Promise<SsoConnectionView> {
  const issuer = cleanIssuer(input.issuer);
  const domains = cleanDomains(input.domains);
  if (!input.client_secret) throw fieldError('client_secret', 'Required');
  await assertDiscoverable(issuer);
  return withIam(async (tx) => {
    const [created] = await tx
      .insert(ssoConnections)
      .values({
        name: input.name,
        issuer,
        client_id: input.client_id,
        client_secret: Buffer.from(await encrypt(input.client_secret!, SECRET_CONTEXT)),
        created_by: actorId,
      })
      .returning();
    await replaceDomains(tx, created!.id, domains);
    await recordAudit(
      tx,
      { action: 'sso.connection_created', actorUserId: actorId, targetType: 'sso_connection', targetId: created!.id, changes: { name: input.name, issuer, domains } },
      meta,
    );
    return view(created!, domains);
  });
}

/**
 * Changing the provider (issuer, client ID or secret) needs a new test, so
 * "required" is switched off until then. A new issuer means new subjects:
 * the links to people are dropped and made again at their next sign-in.
 */
export async function updateSsoConnection(
  actorId: string,
  id: string,
  input: ConnectionInput,
  meta: RequestMeta,
): Promise<SsoConnectionView> {
  const issuer = cleanIssuer(input.issuer);
  const domains = cleanDomains(input.domains);
  const current = await withIam(async (tx) => (await tx.select().from(ssoConnections).where(eq(ssoConnections.id, id)))[0]);
  if (!current) throw new AppError('NOT_FOUND', 'This connection no longer exists.');
  if (issuer !== current.issuer) await assertDiscoverable(issuer);

  return withIam(async (tx) => {
    const [locked] = await tx.select().from(ssoConnections).where(eq(ssoConnections.id, id)).for('update');
    if (!locked) throw new AppError('NOT_FOUND', 'This connection no longer exists.');
    const providerChanged = issuer !== locked.issuer || input.client_id !== locked.client_id || Boolean(input.client_secret);
    const [updated] = await tx
      .update(ssoConnections)
      .set({
        name: input.name,
        issuer,
        client_id: input.client_id,
        ...(input.client_secret && { client_secret: Buffer.from(await encrypt(input.client_secret, SECRET_CONTEXT)) }),
        ...(providerChanged && { tested_at: null, required: false }),
      })
      .where(eq(ssoConnections.id, id))
      .returning();
    if (issuer !== locked.issuer) await tx.delete(ssoIdentities).where(eq(ssoIdentities.connection_id, id));
    const before = await domainsOf(tx, id);
    await replaceDomains(tx, id, domains);
    if (updated!.required) await enforceRequired(tx, updated!);

    const changes: Record<string, unknown> = {};
    if (input.name !== locked.name) changes.name = { from: locked.name, to: input.name };
    if (issuer !== locked.issuer) changes.issuer = { from: locked.issuer, to: issuer };
    if (input.client_id !== locked.client_id) changes.client_id = { from: locked.client_id, to: input.client_id };
    if (input.client_secret) changes.client_secret = 'replaced';
    if (before.join() !== domains.join()) changes.domains = { from: before, to: domains };
    if (providerChanged && locked.required) changes.required = { from: true, to: false };
    await recordAudit(tx, { action: 'sso.connection_updated', actorUserId: actorId, targetType: 'sso_connection', targetId: id, changes }, meta);
    return view(updated!, domains);
  });
}

/** Ends the password sessions of people this requirement now covers (owners excepted). */
async function enforceRequired(tx: Tx, connection: Connection): Promise<number> {
  const domains = await domainsOf(tx, connection.id);
  const covered = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(sql`split_part(${users.email}, '@', 2)`, domains), isNull(users.deleted_at)));
  let ended = 0;
  for (const { id } of covered) {
    if (await hooks.mayUsePasswordAnyway(tx, id)) continue;
    const live = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.user_id, id), eq(sessions.auth_method, 'password'), isNull(sessions.revoked_at)));
    for (const session of live) await revokeSession(tx, session.id, 'sso_required');
    ended += live.length;
  }
  return ended;
}

/** Only after a successful test: a requirement nobody can meet would shut people out. */
export async function setSsoRequired(actorId: string, id: string, required: boolean, meta: RequestMeta): Promise<{ signed_out: number }> {
  return withIam(async (tx) => {
    const [connection] = await tx.select().from(ssoConnections).where(eq(ssoConnections.id, id)).for('update');
    if (!connection) throw new AppError('NOT_FOUND', 'This connection no longer exists.');
    if (required && !connection.tested_at) {
      throw new AppError('CONFLICT', 'Run a test sign-in that works first, so requiring SSO cannot lock people out.');
    }
    if (connection.required === required) return { signed_out: 0 };
    const [updated] = await tx.update(ssoConnections).set({ required }).where(eq(ssoConnections.id, id)).returning();
    const signedOut = required ? await enforceRequired(tx, updated!) : 0;
    await recordAudit(
      tx,
      {
        action: 'sso.required_changed',
        actorUserId: actorId,
        targetType: 'sso_connection',
        targetId: id,
        changes: { name: connection.name, from: connection.required, to: required, signed_out: signedOut },
      },
      meta,
    );
    return { signed_out: signedOut };
  });
}

/** Everyone it signed in is signed out; their links to the provider go with it. */
export async function deleteSsoConnection(actorId: string, id: string, meta: RequestMeta): Promise<void> {
  await withIam(async (tx) => {
    const [connection] = await tx.select().from(ssoConnections).where(eq(ssoConnections.id, id)).for('update');
    if (!connection) throw new AppError('NOT_FOUND', 'This connection no longer exists.');
    const live = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.sso_connection_id, id), isNull(sessions.revoked_at)));
    for (const session of live) await revokeSession(tx, session.id, 'sso_connection_removed');
    await tx.delete(ssoConnections).where(eq(ssoConnections.id, id));
    await recordAudit(
      tx,
      {
        action: 'sso.connection_deleted',
        actorUserId: actorId,
        targetType: 'sso_connection',
        targetId: id,
        changes: { name: connection.name, signed_out: live.length },
      },
      meta,
    );
  });
}

// ─── A trip to the provider (shared by sign-in and test) ────────

async function providerFor(connection: Connection): Promise<Discovery> {
  return discover(connection.issuer);
}

async function newAttempt(
  tx: Tx,
  connection: Connection,
  doc: Discovery,
  p: { purpose: 'sign_in' | 'test'; deviceKeyHash?: Buffer; startedBy?: string; loginHint?: string },
): Promise<{ url: string; state: string }> {
  const state = randomToken();
  const nonce = randomToken();
  const pkce = await pkcePair();
  await tx.insert(ssoAttempts).values({
    connection_id: connection.id,
    purpose: p.purpose,
    state_hash: Buffer.from(await hashToken(state)),
    nonce_hash: Buffer.from(await hashToken(nonce)),
    code_verifier: Buffer.from(await encrypt(pkce.verifier, VERIFIER_CONTEXT)),
    device_key_hash: p.deviceKeyHash ?? null,
    started_by: p.startedBy ?? null,
    expires_at: new Date(Date.now() + AUTH.ssoAttemptSeconds * 1000),
  });
  const url = authorizationUrl(doc, {
    clientId: connection.client_id,
    redirectUri: ssoRedirectUri(),
    state,
    nonce,
    codeChallenge: pkce.challenge,
    loginHint: p.loginHint,
  });
  return { url, state };
}

/** Marks the attempt used (whatever happens next, the code cannot be tried twice) and returns it with its connection. */
async function consumeAttempt(
  state: string,
  match: (attempt: typeof ssoAttempts.$inferSelect) => boolean,
): Promise<{ attempt: typeof ssoAttempts.$inferSelect; connection: Connection } | null> {
  return withIam(async (tx) => {
    const [row] = await tx
      .select({ attempt: ssoAttempts, connection: ssoConnections })
      .from(ssoAttempts)
      .innerJoin(ssoConnections, eq(ssoConnections.id, ssoAttempts.connection_id))
      .where(
        and(
          eq(ssoAttempts.state_hash, Buffer.from(await hashToken(state))),
          isNull(ssoAttempts.consumed_at),
          gt(ssoAttempts.expires_at, sql`now()`),
        ),
      )
      .for('update', { of: ssoAttempts });
    if (!row || !match(row.attempt)) return null;
    await tx.update(ssoAttempts).set({ consumed_at: sql`now()` }).where(eq(ssoAttempts.id, row.attempt.id));
    return row;
  });
}

/** Code → checked ID token claims, nonce included. Throws OidcError. */
async function claimsFor(attempt: typeof ssoAttempts.$inferSelect, connection: Connection, code: string): Promise<IdTokenClaims> {
  const doc = await providerFor(connection);
  const idToken = await exchangeCode(doc, {
    clientId: connection.client_id,
    clientSecret: new TextDecoder().decode(await decrypt(connection.client_secret, SECRET_CONTEXT)),
    code,
    redirectUri: ssoRedirectUri(),
    codeVerifier: new TextDecoder().decode(await decrypt(attempt.code_verifier, VERIFIER_CONTEXT)),
  });
  const claims = await verifyIdToken(doc, idToken, connection.client_id);
  // The answer must belong to this trip, not one replayed from another.
  if (!safeEqual(await hashToken(claims.nonce), attempt.nonce_hash)) throw new OidcError('The ID token belongs to a different sign-in (nonce).');
  return claims;
}

/** Why the provider's answer cannot be used for this connection, or null. Same rules for sign-in and test. */
function claimsProblem(claims: IdTokenClaims, domains: string[]): string | null {
  if (!claims.email) return 'The provider sent no email address. Make sure the "email" scope and claim are allowed for this app.';
  if (claims.email_verified === false) return `The provider says ${claims.email} is not verified.`;
  if (!domains.includes(domainOf(claims.email))) {
    return `${claims.email} is not in this connection's domains (${domains.join(', ')}).`;
  }
  return null;
}

// ─── Signing in ──────────────────────────────────────────────────

const ATTEMPT_EXPIRED = () => new AppError('LINK_INVALID', 'This sign-in has expired. Start again.');
const providerFailed = (name: string) =>
  new AppError('BAD_REQUEST', `Signing in with ${name} didn't work. Try again; if it keeps failing, ask your admin to test the connection.`);

export async function startSsoSignIn(
  input: z.infer<typeof ssoStartSchema>,
  meta: RequestMeta,
): Promise<{ url: string; state: string; connection_name: string; expires_in: number }> {
  if (!(await isUsableDeviceKey(input.device_public_key))) {
    throw new AppError('VALIDATION', 'Some fields are invalid.', { device_public_key: 'Invalid device key' });
  }
  await rateLimit(`sso:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.ssoPerIp);
  const connection = await withIam((tx) => connectionForDomain(tx, domainOf(input.email)));
  if (!connection) throw fieldError('email', `Single sign-on isn't set up for ${domainOf(input.email)}. Sign in with your password.`);

  let doc: Discovery;
  try {
    doc = await providerFor(connection);
  } catch (err) {
    logger.auth.warn({ connection: connection.id, err: err instanceof Error ? err.message : err }, 'SSO provider unreachable');
    throw new AppError('UNAVAILABLE', `Couldn't reach ${connection.name}. Try again in a moment, or ask your admin.`);
  }
  const hash = await deviceKeyHash(input.device_public_key);
  const { url, state } = await withIam((tx) =>
    newAttempt(tx, connection, doc, { purpose: 'sign_in', deviceKeyHash: hash, loginHint: input.email }),
  );
  return { url, state, connection_name: connection.name, expires_in: AUTH.ssoAttemptSeconds };
}

type SignInOutcome = { ok: TokenPair } | { fail: string; reason: string; userId?: string };

/** Back from the provider: who it is (see the top of this file), then a session. */
export async function finishSsoSignIn(input: z.infer<typeof ssoFinishSchema>, meta: RequestMeta): Promise<TokenPair> {
  await rateLimit(`sso:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.ssoPerIp);
  if (!(await isUsableDeviceKey(input.device_public_key))) throw ATTEMPT_EXPIRED();
  const hash = await deviceKeyHash(input.device_public_key);
  // The code must come back to the device that left for the provider.
  const open = await consumeAttempt(
    input.state,
    (a) => a.purpose === 'sign_in' && a.device_key_hash !== null && safeEqual(a.device_key_hash, hash),
  );
  if (!open) throw ATTEMPT_EXPIRED();
  const { attempt, connection } = open;

  let claims: IdTokenClaims;
  try {
    claims = await claimsFor(attempt, connection, input.code);
  } catch (err) {
    if (!(err instanceof OidcError)) throw err;
    logger.auth.warn({ connection: connection.id, reason: err.message }, 'SSO sign-in failed');
    await withIam((tx) =>
      recordAudit(tx, { action: 'auth.sso_failed', targetType: 'sso_connection', targetId: connection.id, changes: { connection: connection.name, reason: err.message } }, meta),
    );
    throw providerFailed(connection.name);
  }

  const outcome = await withIam(async (tx): Promise<SignInOutcome> => {
    const domains = await domainsOf(tx, connection.id);
    const problem = claimsProblem(claims, domains);
    if (problem) return { fail: `${connection.name} vouched for an account this sign-in doesn't cover. Ask your admin.`, reason: problem };
    const email = claims.email!;

    let userId: string | null = null;
    const [identity] = await tx
      .select()
      .from(ssoIdentities)
      .where(and(eq(ssoIdentities.connection_id, connection.id), eq(ssoIdentities.subject, claims.sub)));
    if (identity) {
      userId = identity.user_id;
    } else {
      const existing = await findUserByEmail(tx, email);
      userId = existing?.id ?? (await hooks.provisionInvited(tx, { email, name: claims.name }, meta));
      if (!userId) {
        return { fail: `There is no account for ${email} here. Ask your admin for an invitation.`, reason: `no account or invitation for ${email}` };
      }
      try {
        await tx.insert(ssoIdentities).values({ connection_id: connection.id, subject: claims.sub, user_id: userId, email });
      } catch (err) {
        // The same person finishing two sign-ins at once: the other one linked it.
        if (!isUniqueViolation(err, 'sso_identities_subject')) throw err;
      }
      await recordAudit(
        tx,
        { action: 'auth.sso_linked', actorUserId: userId, targetType: 'sso_connection', targetId: connection.id, changes: { connection: connection.name, email } },
        meta,
      );
    }

    const user = await getUser(tx, userId);
    if (!user || user.status !== 'active') {
      return { fail: 'This account is deactivated. Ask your admin.', reason: 'account deactivated', userId };
    }
    await tx
      .update(ssoIdentities)
      .set({ last_sign_in_at: sql`now()` })
      .where(and(eq(ssoIdentities.connection_id, connection.id), eq(ssoIdentities.subject, claims.sub)));
    await recordAudit(tx, { action: 'auth.login', actorUserId: user.id, changes: { method: 'sso', connection: connection.name } }, meta);
    // The provider ran its own checks (and MFA): no code from us on top.
    return {
      ok: await createSession(tx, {
        userId: user.id,
        devicePublicKey: input.device_public_key,
        browserId: input.browser_id,
        meta,
        ssoConnectionId: connection.id,
      }),
    };
  });

  if ('ok' in outcome) return outcome.ok;
  await withIam((tx) =>
    recordAudit(
      tx,
      {
        action: 'auth.sso_failed',
        actorUserId: outcome.userId ?? null,
        targetType: 'sso_connection',
        targetId: connection.id,
        changes: { connection: connection.name, reason: outcome.reason },
      },
      meta,
    ),
  );
  throw new AppError('FORBIDDEN', outcome.fail);
}

// ─── Testing a connection (owners, from Settings; no session) ───

export async function startSsoTest(actorId: string, connectionId: string): Promise<{ url: string; state: string }> {
  await rateLimit(`sso:test:${actorId}`, RATE_LIMITS.ssoPerIp);
  const connection = await withIam(async (tx) => (await tx.select().from(ssoConnections).where(eq(ssoConnections.id, connectionId)))[0]);
  if (!connection) throw new AppError('NOT_FOUND', 'This connection no longer exists.');
  let doc: Discovery;
  try {
    doc = await discover(connection.issuer, { fresh: true });
  } catch (err) {
    if (err instanceof OidcError) throw new AppError('BAD_REQUEST', err.message);
    throw err;
  }
  return withIam((tx) => newAttempt(tx, connection, doc, { purpose: 'test', startedBy: actorId }));
}

export interface SsoTestResult {
  connection_id: string;
  connection_name: string;
  ok: boolean;
  /** What went wrong, in words for the person setting it up. */
  problem: string | null;
  /** What the provider said about the account used for the test. */
  claims: { sub: string; email: string | null; email_verified: boolean | null; name: string | null } | null;
}

export async function finishSsoTest(
  auth: AuthContext,
  input: z.infer<typeof ssoTestFinishSchema>,
  meta: RequestMeta,
): Promise<SsoTestResult> {
  const open = await consumeAttempt(input.state, (a) => a.purpose === 'test' && a.started_by === auth.userId);
  if (!open) throw new AppError('LINK_INVALID', 'This test has expired. Start it again.');
  const { attempt, connection } = open;

  let claims: IdTokenClaims | null = null;
  let problem: string | null;
  try {
    claims = await claimsFor(attempt, connection, input.code);
    problem = claimsProblem(claims, await withIam((tx) => domainsOf(tx, connection.id)));
  } catch (err) {
    if (!(err instanceof OidcError)) throw err;
    problem = err.message;
  }

  await withIam(async (tx) => {
    if (!problem) await tx.update(ssoConnections).set({ tested_at: sql`now()` }).where(eq(ssoConnections.id, connection.id));
    await recordAudit(
      tx,
      {
        action: 'sso.tested',
        actorUserId: auth.userId,
        targetType: 'sso_connection',
        targetId: connection.id,
        changes: { name: connection.name, ok: !problem, ...(problem && { problem }) },
      },
      meta,
    );
  });
  return {
    connection_id: connection.id,
    connection_name: connection.name,
    ok: !problem,
    problem,
    claims: claims && { sub: claims.sub, email: claims.email, email_verified: claims.email_verified, name: claims.name },
  };
}

// ─── Your own account ────────────────────────────────────────────

/** For the Account page: whether there is a password to change, and which SSO connections sign you in. */
export async function signInMethods(auth: AuthContext): Promise<{ password: boolean; sso: string[] }> {
  return withIam(async (tx) => {
    const user = await getUser(tx, auth.userId);
    const linked = await tx
      .select({ name: ssoConnections.name })
      .from(ssoIdentities)
      .innerJoin(ssoConnections, eq(ssoConnections.id, ssoIdentities.connection_id))
      .where(eq(ssoIdentities.user_id, auth.userId));
    return { password: Boolean(user?.password_hash), sso: linked.map((l) => l.name) };
  });
}

// ─── Housekeeping ────────────────────────────────────────────────

export async function cleanUpSso(tx: Tx): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION.signInChallengesSeconds * 1000);
  const deleted = await tx
    .delete(ssoAttempts)
    .where(or(lt(ssoAttempts.expires_at, cutoff), lt(ssoAttempts.consumed_at, cutoff)))
    .returning({ id: ssoAttempts.id });
  return deleted.length;
}
