/**
 * Sign-in, refresh, sign-out and passwords. The numbered comments in
 * `refresh` are its eight checks, in order.
 *
 * Slow work (argon2) runs outside transactions so it never holds a pooled
 * connection, and rate-limit counters commit separately so failed attempts
 * are still counted.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { withIam } from '#/db/db';
import type { DevicePublicKey } from '#/db/schema';
import { oneTimeTokens, sessions, users } from '#/db/schema';
import { hashToken, randomToken } from '#/libs/crypto';
import type { ErrorCode } from '#/libs/errors';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import { enqueueEmail } from '#/modules/notifications';

import { AUTH, RATE_LIMITS } from './iam.config';
import { passwordChangedEmail, passwordResetEmail, ssoRequiredEmail } from './iam.emails';
import type {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  resetPasswordSchema,
} from './iam.validators';
import { assertCurrentPassword, hashPassword, verifyPassword } from './passwords';
import { attempts, rateLimit, resetLimit, withinLimit } from './rate-limit';
import type { SessionSummary, TokenPair } from './sessions';
import {
  createSession,
  listUserSessions,
  revokeSession,
  revokeUserSession,
  revokeUserSessions,
  sessionKey,
  tokenPair,
} from './sessions';
import { isUsableDeviceKey, parseRefreshToken, refreshTokenMacValid, verifyDeviceProof } from './tokens';
import type { SignInResult } from './two-factor';
import { isPending, startSignIn } from './two-factor';
import { passwordRefusedFor, ssoRequiredError } from './sso';
import { findUserByEmail, getUser } from './users';

/** Who is calling, set by requireAuth. */
export interface AuthContext {
  userId: string;
  sessionId: string;
}

const ipKey = (meta: RequestMeta) => meta.ip ?? 'unknown';

/** Rejects a device key that is well-formed text but not a real P-256 point. */
export async function assertUsableDeviceKey(key: DevicePublicKey): Promise<void> {
  if (!(await isUsableDeviceKey(key))) {
    throw new AppError('VALIDATION', 'Some fields are invalid.', { device_public_key: 'Invalid device key' });
  }
}

// ─── Login ───────────────────────────────────────────────────────

/** A session, or (with two-factor on or required) the challenge for the next step. */
export async function login(input: z.infer<typeof loginSchema>, meta: RequestMeta): Promise<SignInResult> {
  await assertUsableDeviceKey(input.device_public_key);
  await rateLimit(`login:ip:${ipKey(meta)}`, RATE_LIMITS.loginPerIp);

  const failKey = `login-fail:${input.email}`;
  const failures = await attempts(failKey, RATE_LIMITS.loginFailuresPerEmail);
  if (failures.count >= RATE_LIMITS.loginFailuresPerEmail[0]) {
    throw new AppError('RATE_LIMITED', 'Too many failed sign-ins. Try again later.', {
      retry_after: failures.retryAfter,
    });
  }

  const user = await withIam((tx) => findUserByEmail(tx, input.email));
  // Always hashes, known email or not, so timing gives nothing away. The
  // status is checked only after the password, for the same reason.
  const passwordOk = await verifyPassword(input.password, user?.password_hash);

  if (!user || !passwordOk || user.status !== 'active') {
    await withinLimit(failKey, RATE_LIMITS.loginFailuresPerEmail);
    await withIam((tx) =>
      recordAudit(tx, { action: 'auth.login_failed', actorUserId: user?.id ?? null, changes: { email: input.email } }, meta),
    );
    throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  const result = await withIam(async (tx) => {
    // Checked after the password, so it says nothing about accounts to someone guessing.
    const sso = await passwordRefusedFor(tx, user);
    if (sso) throw ssoRequiredError(sso.name);
    const next = await startSignIn(tx, user.id, { devicePublicKey: input.device_public_key, browserId: input.browser_id }, meta);
    // With a code still to come, the sign-in is recorded when it arrives.
    if (!isPending(next)) await recordAudit(tx, { action: 'auth.login', actorUserId: user.id }, meta);
    return next;
  });
  // The failure count starts over only once the person is really in.
  if (!isPending(result)) await resetLimit(failKey);
  return result;
}

// ─── Refresh ─────────────────────────────────────────────────────

const REFRESH_FAILURES: Partial<Record<ErrorCode, string>> = {
  SESSION_EXPIRED: 'Your session has ended. Please sign in again.',
  INVALID_DEVICE_PROOF: 'This device could not be verified. Please sign in again.',
  REFRESH_TOKEN_REUSED: 'Your session was ended for safety. Please sign in again.',
};

type RefreshOutcome = { pair: TokenPair } | { fail: 'SESSION_EXPIRED' | 'INVALID_DEVICE_PROOF' | 'REFRESH_TOKEN_REUSED' };

export async function refresh(input: z.infer<typeof refreshSchema>, meta: RequestMeta): Promise<TokenPair> {
  // 1 · read the token
  const parts = parseRefreshToken(input.refresh_token);
  if (!parts) throw new AppError('SESSION_EXPIRED', REFRESH_FAILURES.SESSION_EXPIRED!);

  // 2 · rate limits: per session, plus a generous ceiling per IP
  await rateLimit(`refresh:session:${parts.sessionId}`, RATE_LIMITS.refreshPerSession);
  await rateLimit(`refresh:ip:${ipKey(meta)}`, RATE_LIMITS.refreshPerIp);

  // Failures that change state (revoking) must commit, so the transaction
  // returns them instead of throwing, and the error is thrown afterwards.
  const outcome = await withIam(async (tx): Promise<RefreshOutcome> => {
    // 3 · load and lock the session: one refresh per session at a time
    const [row] = await tx
      .select({ session: sessions, userActive: users.is_active })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.user_id))
      .where(eq(sessions.id, parts.sessionId))
      .for('update', { of: sessions });

    const now = Date.now();
    const session = row?.session;
    if (
      !session ||
      session.revoked_at ||
      session.not_after.getTime() <= now ||
      session.refreshed_at.getTime() <= now - AUTH.sessionIdleSeconds * 1000
    ) {
      return { fail: 'SESSION_EXPIRED' };
    }

    // 4 · HMAC under this session's key
    const key = await sessionKey(session.refresh_hmac_key);
    if (!(await refreshTokenMacValid(parts, key))) return { fail: 'SESSION_EXPIRED' };

    // 5 · device proof. Before the counter: a stolen token without the key is
    //     refused here and cannot trigger the reuse alarm (which would sign
    //     the real user out). The session is left alone.
    if (!(await verifyDeviceProof(input.proof, session.device_public_key, input.refresh_token))) {
      return { fail: 'INVALID_DEVICE_PROOF' };
    }

    // 7 · user still active (checked here, before rotating)
    if (!row.userActive) {
      await revokeSession(tx, session.id, 'user_disabled');
      return { fail: 'SESSION_EXPIRED' };
    }

    // 6 · counter
    if (parts.counter === session.refresh_counter) {
      // 8 · rotate and answer
      const next = session.refresh_counter + 1;
      await tx
        .update(sessions)
        .set({ refresh_counter: next, refreshed_at: new Date(), ip: meta.ip, user_agent: meta.userAgent })
        .where(eq(sessions.id, session.id));
      return { pair: await tokenPair(session.user_id, session.id, next, key) };
    }
    if (parts.counter === session.refresh_counter - 1) {
      // One step behind: the previous answer never reached the browser (a
      // reload mid-refresh, a dropped connection). The proof shows it is the
      // same device, so hand back the current pair instead of signing it out.
      return { pair: await tokenPair(session.user_id, session.id, session.refresh_counter, key) };
    }
    // Anything older: two parties hold this chain. End it for both.
    await revokeSession(tx, session.id, 'refresh_token_reused');
    await recordAudit(
      tx,
      { action: 'auth.token_revoked', actorUserId: session.user_id, targetType: 'session', targetId: session.id, changes: { reason: 'refresh_token_reused' } },
      meta,
    );
    return { fail: 'REFRESH_TOKEN_REUSED' };
  });

  if ('fail' in outcome) throw new AppError(outcome.fail, REFRESH_FAILURES[outcome.fail]!);
  return outcome.pair;
}

// ─── Logout ──────────────────────────────────────────────────────

export async function logout(auth: AuthContext, scope: 'local' | 'others' | 'global', meta: RequestMeta) {
  await withIam(async (tx) => {
    if (scope === 'local') await revokeSession(tx, auth.sessionId, 'logout');
    else if (scope === 'others') await revokeUserSessions(tx, auth.userId, 'logout_others', auth.sessionId);
    else await revokeUserSessions(tx, auth.userId, 'logout_everywhere');
    await recordAudit(tx, { action: 'auth.logout', actorUserId: auth.userId, changes: { scope } }, meta);
  });
}

// ─── Your devices ────────────────────────────────────────────────

export async function listMySessions(auth: AuthContext): Promise<SessionSummary[]> {
  return withIam((tx) => listUserSessions(tx, auth.userId, auth.sessionId));
}

/**
 * Signs out one of your other devices. Your own session ends with logout
 * instead, so the client also forgets its tokens.
 */
export async function endMySession(auth: AuthContext, sessionId: string, meta: RequestMeta): Promise<void> {
  if (sessionId === auth.sessionId) {
    throw new AppError('BAD_REQUEST', 'This is the device you are using. Use Sign out instead.');
  }
  await withIam(async (tx) => {
    // Someone else's session, or already ended: the same answer either way.
    if (!(await revokeUserSession(tx, auth.userId, sessionId, 'signed_out_from_account'))) {
      throw new AppError('NOT_FOUND', 'That session has already ended.');
    }
    await recordAudit(tx, { action: 'auth.session_ended', actorUserId: auth.userId, targetType: 'session', targetId: sessionId }, meta);
  });
}

// ─── Passwords ───────────────────────────────────────────────────

export async function changePassword(
  auth: AuthContext,
  input: z.infer<typeof changePasswordSchema>,
  meta: RequestMeta,
): Promise<void> {
  const user = await withIam((tx) => getUser(tx, auth.userId));
  if (!user) throw new AppError('SESSION_EXPIRED', REFRESH_FAILURES.SESSION_EXPIRED!);

  await assertCurrentPassword(user, input.current_password);

  const hash = await hashPassword(input.new_password);
  await withIam(async (tx) => {
    await tx.update(users).set({ password_hash: hash }).where(eq(users.id, user.id));
    await revokeUserSessions(tx, user.id, 'password_changed', auth.sessionId);
    await recordAudit(tx, { action: 'auth.password_changed', actorUserId: user.id }, meta);
    await enqueueEmail(tx, passwordChangedEmail(user.email));
  });
}

/** Always succeeds from the caller's point of view: the answer never reveals whether the email has an account. */
/** A fresh single-use reset link for an active account, emailed to it. Replaces any earlier link. */
async function issueRecoveryLink(tx: Tx, user: { id: string; email: string }) {
  const token = randomToken();
  // One live reset link per user: asking again replaces the old one.
  await tx
    .delete(oneTimeTokens)
    .where(and(eq(oneTimeTokens.user_id, user.id), eq(oneTimeTokens.type, 'recovery'), isNull(oneTimeTokens.consumed_at)));
  await tx.insert(oneTimeTokens).values({
    user_id: user.id,
    type: 'recovery',
    token_hash: Buffer.from(await hashToken(token)),
    expires_at: new Date(Date.now() + AUTH.recoveryTokenSeconds * 1000),
  });
  await enqueueEmail(tx, passwordResetEmail(user.email, token));
}

/** Always succeeds from the caller's point of view: the answer never reveals whether the email has an account. */
export async function forgotPassword(input: z.infer<typeof forgotPasswordSchema>, meta: RequestMeta): Promise<void> {
  await rateLimit(`forgot:ip:${ipKey(meta)}`, RATE_LIMITS.forgotPerIp);
  if (!(await withinLimit(`forgot:email:${input.email}`, RATE_LIMITS.forgotPerEmail))) return;

  await withIam(async (tx) => {
    const user = await findUserByEmail(tx, input.email);
    if (!user || user.status !== 'active') return;
    // A reset link would be no use: say how they sign in instead.
    const sso = await passwordRefusedFor(tx, user);
    if (sso) {
      await enqueueEmail(tx, ssoRequiredEmail(user.email, sso.name));
      return;
    }
    await issueRecoveryLink(tx, user);
    await recordAudit(tx, { action: 'auth.password_reset_requested', actorUserId: user.id }, meta);
  });
}

// ─── For administrators (the caller has checked who may) ─────────

/** Emails an active account a reset link, inside the caller's transaction. */
export async function sendPasswordResetLink(tx: Tx, userId: string): Promise<void> {
  const user = await getUser(tx, userId);
  if (!user) throw new AppError('NOT_FOUND', 'This person does not exist.');
  if (user.status !== 'active') throw new AppError('CONFLICT', 'This account is deactivated. Reactivate it first.');
  if (await passwordRefusedFor(tx, user)) {
    throw new AppError('CONFLICT', 'This person signs in with single sign-on, so a password reset link would not help.');
  }
  await issueRecoveryLink(tx, user);
}

/**
 * Deactivated: sign-in is refused and every session ends now (other API
 * processes notice within the session-check cache, 15 s). Reactivated: they
 * can sign in again. Returns false when it already was that way.
 */
export async function setAccountActive(tx: Tx, userId: string, active: boolean): Promise<boolean> {
  const [user] = await tx
    .select({ status: users.status })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deleted_at)))
    .for('update');
  if (!user) throw new AppError('NOT_FOUND', 'This person does not exist.');
  const next = active ? 'active' : 'disabled';
  if (user.status === next) return false;
  await tx.update(users).set({ status: next }).where(eq(users.id, userId));
  if (!active) {
    await revokeUserSessions(tx, userId, 'user_disabled');
    // Their open reset link would sign them straight back in.
    await tx
      .delete(oneTimeTokens)
      .where(and(eq(oneTimeTokens.user_id, userId), eq(oneTimeTokens.type, 'recovery'), isNull(oneTimeTokens.consumed_at)));
  }
  return true;
}

/** The new password, then a session, or the two-factor step when it is on: a reset link alone never skips the code. */
export async function resetPassword(input: z.infer<typeof resetPasswordSchema>, meta: RequestMeta): Promise<SignInResult> {
  await assertUsableDeviceKey(input.device_public_key);
  await rateLimit(`link:ip:${ipKey(meta)}`, RATE_LIMITS.linkPerIp);

  const hash = await hashPassword(input.password);
  const tokenHash = Buffer.from(await hashToken(input.token));

  const result = await withIam(async (tx) => {
    const [row] = await tx
      .select()
      .from(oneTimeTokens)
      .where(
        and(
          eq(oneTimeTokens.token_hash, tokenHash),
          eq(oneTimeTokens.type, 'recovery'),
          isNull(oneTimeTokens.consumed_at),
          gt(oneTimeTokens.expires_at, sql`now()`),
        ),
      )
      .for('update');
    if (!row?.user_id) return null;
    const user = await getUser(tx, row.user_id);
    if (!user || user.status !== 'active') return null;
    const sso = await passwordRefusedFor(tx, user);
    if (sso) throw ssoRequiredError(sso.name);

    await tx.update(oneTimeTokens).set({ consumed_at: new Date() }).where(eq(oneTimeTokens.id, row.id));
    // Opening a link sent to the address proves the person owns it.
    await tx
      .update(users)
      .set({ password_hash: hash, email_confirmed_at: user.email_confirmed_at ?? new Date() })
      .where(eq(users.id, user.id));
    await revokeUserSessions(tx, user.id, 'password_reset');
    await recordAudit(tx, { action: 'auth.password_reset', actorUserId: user.id }, meta);
    await enqueueEmail(tx, passwordChangedEmail(user.email));
    const next = await startSignIn(tx, user.id, { devicePublicKey: input.device_public_key, browserId: input.browser_id }, meta);
    return { next, email: user.email };
  });

  if (!result) throw new AppError('LINK_INVALID', 'This link is invalid or has expired. Ask for a new one.');
  if (!isPending(result.next)) await resetLimit(`login-fail:${result.email}`);
  return result.next;
}
