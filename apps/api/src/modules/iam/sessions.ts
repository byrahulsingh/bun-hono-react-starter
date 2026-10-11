import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';

import type { Tx } from '#/db/db';
import { withIam } from '#/db/db';
import type { DevicePublicKey } from '#/db/schema';
import { sessions, users } from '#/db/schema';
import { decrypt, encrypt } from '#/libs/crypto';
import type { RequestMeta } from '#/libs/request-meta';

import { AUTH } from './iam.config';
import { noteSignIn } from './known-devices';
import { encodeRefreshToken, issueAccessToken } from './tokens';

export const SESSION_KEY_CONTEXT = 'iam.sessions.refresh_hmac_key';

/** What every successful sign-in, setup, reset or refresh returns. */
export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  /** Seconds until the access token expires. */
  expires_in: number;
  refresh_token: string;
}

export async function tokenPair(
  userId: string,
  sessionId: string,
  counter: number,
  sessionKey: Uint8Array,
): Promise<TokenPair> {
  return {
    access_token: await issueAccessToken({ sub: userId, sid: sessionId }),
    token_type: 'Bearer',
    expires_in: AUTH.accessTokenSeconds,
    refresh_token: await encodeRefreshToken({ sessionId, counter }, sessionKey),
  };
}

export async function sessionKey(encrypted: Uint8Array): Promise<Uint8Array> {
  return decrypt(encrypted, SESSION_KEY_CONTEXT);
}

/** Who is signing in, from where: what every way of signing in hands to createSession. */
export interface SignInDevice {
  devicePublicKey: DevicePublicKey;
  /** The browser's lasting id (known-devices.ts), when it sent one. */
  browserId?: string | null;
}

/**
 * A new session for a device, inside the caller's transaction. Every way of
 * signing in ends here (password, setup, invitation, reset), so this is also
 * where the last sign-in time is kept and a new browser is reported.
 */
export async function createSession(
  tx: Tx,
  input: SignInDevice & { userId: string; meta: RequestMeta; ssoConnectionId?: string },
): Promise<TokenPair> {
  await tx.update(users).set({ last_login_at: new Date() }).where(eq(users.id, input.userId));
  const key = crypto.getRandomValues(new Uint8Array(32));
  const [session] = await tx
    .insert(sessions)
    .values({
      user_id: input.userId,
      device_public_key: input.devicePublicKey,
      refresh_hmac_key: Buffer.from(await encrypt(key, SESSION_KEY_CONTEXT)),
      not_after: new Date(Date.now() + AUTH.sessionMaxSeconds * 1000),
      ip: input.meta.ip,
      user_agent: input.meta.userAgent,
      auth_method: input.ssoConnectionId ? 'sso' : 'password',
      sso_connection_id: input.ssoConnectionId ?? null,
    })
    .returning({ id: sessions.id });
  await noteSignIn(tx, { userId: input.userId, sessionId: session!.id, browserId: input.browserId, meta: input.meta });
  return tokenPair(input.userId, session!.id, 0, key);
}

export type RevokeReason =
  | 'logout'
  | 'logout_others'
  | 'logout_everywhere'
  | 'refresh_token_reused'
  | 'password_changed'
  | 'password_reset'
  | 'user_disabled'
  | 'signed_out_from_account'
  | 'two_factor_reset'
  | 'reported_by_user'
  | 'sso_required'
  | 'sso_connection_removed';

export async function revokeSession(tx: Tx, sessionId: string, reason: RevokeReason): Promise<void> {
  await tx
    .update(sessions)
    .set({ revoked_at: new Date(), revoked_reason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revoked_at)));
  forgetSession(sessionId);
}

/** One session, only if it belongs to `userId` and is not already revoked. True when it was ended. */
export async function revokeUserSession(tx: Tx, userId: string, sessionId: string, reason: RevokeReason): Promise<boolean> {
  const revoked = await tx
    .update(sessions)
    .set({ revoked_at: new Date(), revoked_reason: reason })
    .where(and(eq(sessions.id, sessionId), eq(sessions.user_id, userId), isNull(sessions.revoked_at)))
    .returning({ id: sessions.id });
  forgetSession(sessionId);
  return revoked.length > 0;
}

/** Every live session of a user, optionally keeping one (the caller's own). */
export async function revokeUserSessions(
  tx: Tx,
  userId: string,
  reason: RevokeReason,
  keepSessionId?: string,
): Promise<number> {
  const revoked = await tx
    .update(sessions)
    .set({ revoked_at: new Date(), revoked_reason: reason })
    .where(
      and(
        eq(sessions.user_id, userId),
        isNull(sessions.revoked_at),
        keepSessionId ? ne(sessions.id, keepSessionId) : undefined,
      ),
    )
    .returning({ id: sessions.id });
  for (const { id } of revoked) forgetSession(id);
  return revoked.length;
}

/** The conditions for a usable session: not revoked, not past its end, not idle too long. */
function liveSession() {
  const idleCutoff = sql`now() - make_interval(secs => ${AUTH.sessionIdleSeconds})`;
  return and(isNull(sessions.revoked_at), gt(sessions.not_after, sql`now()`), gt(sessions.refreshed_at, idleCutoff));
}

export interface SessionSummary {
  id: string;
  /** The browser's User-Agent at sign-in; the client turns it into "Chrome on macOS". */
  user_agent: string | null;
  ip: string | null;
  created_at: Date;
  /** Last refresh: the device has been in use since about then (refreshes happen every ~10 minutes). */
  last_active_at: Date;
  current: boolean;
}

/** A user's live sessions: the caller's own first, then the most recently active. */
export async function listUserSessions(tx: Tx, userId: string, currentSessionId: string): Promise<SessionSummary[]> {
  const rows = await tx
    .select({
      id: sessions.id,
      user_agent: sessions.user_agent,
      ip: sessions.ip,
      created_at: sessions.created_at,
      last_active_at: sessions.refreshed_at,
    })
    .from(sessions)
    .where(and(eq(sessions.user_id, userId), liveSession()))
    .orderBy(desc(sessions.refreshed_at))
    .limit(100);
  return rows
    .map((r) => ({ ...r, current: r.id === currentSessionId }))
    .sort((a, b) => Number(b.current) - Number(a.current));
}

// ─── Is this session still alive? (checked on every authenticated request) ──
//
// Makes sign-out, "sign out everywhere", disabling a user and token-reuse
// detection take effect within seconds instead of when the access token
// expires. Cached briefly per process: this process forgets a session the
// moment it revokes it; other replicas notice within the cache time.

const aliveCache = new Map<string, { alive: boolean; until: number }>();

function forgetSession(sessionId: string) {
  aliveCache.delete(sessionId);
}

export async function isSessionAlive(sessionId: string, userId: string): Promise<boolean> {
  const cached = aliveCache.get(sessionId);
  if (cached && cached.until > Date.now()) return cached.alive;

  const rows = await withIam((tx) =>
    tx
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.user_id))
      .where(and(eq(sessions.id, sessionId), eq(sessions.user_id, userId), liveSession(), eq(users.is_active, true))),
  );
  const alive = rows.length === 1;
  if (aliveCache.size > 10_000) aliveCache.clear();
  aliveCache.set(sessionId, { alive, until: Date.now() + AUTH.sessionCheckCacheSeconds * 1000 });
  return alive;
}

/** Tests only. */
export function resetSessionCache() {
  aliveCache.clear();
}
