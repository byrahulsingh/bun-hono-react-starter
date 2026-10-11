/**
 * Two-factor sign-in: an authenticator app (TOTP) plus single-use recovery
 * codes.
 *
 * Every way of signing in (password, reset link, invitation) goes through
 * startSignIn: with two-factor on, it hands back a challenge instead of a
 * session, and only a correct code turns that into one. With two-factor
 * required (the organization's rule) but not set up, the challenge is for
 * setting it up first. Nothing else creates sessions for an existing person.
 */

import { and, count, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { withIam } from '#/db/db';
import type { DevicePublicKey } from '#/db/schema';
import { recoveryCodes, signInChallenges, totpFactors } from '#/db/schema';
import { decrypt, encrypt, hashToken, randomToken, safeEqual, sha256 } from '#/libs/crypto';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import { enqueueEmail } from '#/modules/notifications';

import { AUTH, RATE_LIMITS, RETENTION } from './iam.config';
import {
  recoveryCodeUsedEmail,
  recoveryCodesReplacedEmail,
  twoFactorDisabledEmail,
  twoFactorEnabledEmail,
} from './iam.emails';
import type {
  disableTwoFactorSchema,
  passwordOnlySchema,
  signInCodeSchema,
  signInSetupSchema,
  codeOnlySchema,
} from './iam.validators';
import { assertCurrentPassword } from './passwords';
import { attempts, rateLimit, resetLimit, withinLimit } from './rate-limit';
import type { SignInDevice, TokenPair } from './sessions';
import { createSession, revokeUserSessions } from './sessions';
import { isUsableDeviceKey } from './tokens';
import type { AuthContext } from './iam.service';
import { base32Encode, matchTotp, newTotpSecret } from './totp';
import { getUser } from './users';

const SECRET_CONTEXT = 'iam.totp_factors.secret';
/** No 0/o, 1/l/i: read off a printout without guessing. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const INCORRECT_CODE = () => new AppError('VALIDATION', 'Some fields are invalid.', { code: 'Incorrect code' });
const SIGN_IN_EXPIRED = () =>
  new AppError('LINK_INVALID', 'This sign-in has expired. Enter your email and password again.');

// ─── Who must use it (the organization decides; see requireTwoFactorWhen) ──

type Requirement = (tx: Tx, userId: string) => Promise<boolean>;
let requirement: Requirement = async () => false;

/**
 * How the app says who must use two-factor (the tenancy module: the
 * organization's rule). Auth knows nothing about organizations itself.
 */
export function requireTwoFactorWhen(fn: Requirement) {
  requirement = fn;
}

// ─── Factors and recovery codes ──────────────────────────────────

async function factorOf(tx: Tx, userId: string, opts: { lock?: boolean } = {}) {
  const query = tx.select().from(totpFactors).where(eq(totpFactors.user_id, userId));
  const [row] = opts.lock ? await query.for('update') : await query;
  return row;
}

/** True when the person has a working authenticator app. */
export async function hasTwoFactor(tx: Tx, userId: string): Promise<boolean> {
  const factor = await factorOf(tx, userId);
  return Boolean(factor?.confirmed_at);
}

/** Of `ids`, those with two-factor on (the People directory's badge). */
export async function twoFactorUsersAmong(tx: Tx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: totpFactors.user_id })
    .from(totpFactors)
    .where(and(inArray(totpFactors.user_id, ids), isNotNull(totpFactors.confirmed_at)));
  return new Set(rows.map((r) => r.id));
}

const secretOf = async (row: { secret: Uint8Array }) => decrypt(row.secret, SECRET_CONTEXT);

/** A new unconfirmed secret, replacing any earlier unfinished one. Returns it in base32 for the app. */
async function newPendingFactor(tx: Tx, userId: string): Promise<string> {
  const secret = newTotpSecret();
  await tx.delete(totpFactors).where(and(eq(totpFactors.user_id, userId), isNull(totpFactors.confirmed_at)));
  await tx.insert(totpFactors).values({ user_id: userId, secret: Buffer.from(await encrypt(secret, SECRET_CONTEXT)) });
  return base32Encode(secret);
}

/** Confirms the pending secret if `code` is right for it. False when there is none or the code is wrong. */
async function confirmPendingFactor(tx: Tx, userId: string, code: string): Promise<boolean> {
  const factor = await factorOf(tx, userId, { lock: true });
  if (!factor || factor.confirmed_at) return false;
  const step = matchTotp(await secretOf(factor), code, null);
  if (step === null) return false;
  await tx
    .update(totpFactors)
    .set({ confirmed_at: sql`now()`, last_used_step: step })
    .where(eq(totpFactors.user_id, userId));
  return true;
}

const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

function newRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** A fresh set of recovery codes; every earlier one stops working. Returns them, the only time they exist in the clear. */
async function replaceRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
  await tx.delete(recoveryCodes).where(eq(recoveryCodes.user_id, userId));
  const codes = Array.from({ length: AUTH.recoveryCodeCount }, newRecoveryCode);
  await tx.insert(recoveryCodes).values(
    await Promise.all(
      codes.map(async (code) => ({ user_id: userId, code_hash: Buffer.from(await hashToken(normalizeRecoveryCode(code))) })),
    ),
  );
  return codes;
}

async function recoveryCodesLeft(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.user_id, userId), isNull(recoveryCodes.used_at)));
  return row?.n ?? 0;
}

/**
 * Checks a code from the app (6 digits) or a recovery code, and uses it up.
 * A recovery code also emails the person, so a stolen one is noticed.
 */
async function useSecondFactor(
  tx: Tx,
  user: { id: string; email: string },
  code: string,
): Promise<'totp' | 'recovery_code' | null> {
  const factor = await factorOf(tx, user.id, { lock: true });
  if (!factor?.confirmed_at) return null;

  if (/^\d{6}$/.test(code.trim())) {
    const step = matchTotp(await secretOf(factor), code.trim(), factor.last_used_step);
    if (step === null) return null;
    await tx.update(totpFactors).set({ last_used_step: step }).where(eq(totpFactors.user_id, user.id));
    return 'totp';
  }

  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 10) return null;
  const used = await tx
    .update(recoveryCodes)
    .set({ used_at: sql`now()` })
    .where(
      and(
        eq(recoveryCodes.user_id, user.id),
        eq(recoveryCodes.code_hash, Buffer.from(await hashToken(normalized))),
        isNull(recoveryCodes.used_at),
      ),
    )
    .returning({ id: recoveryCodes.id });
  if (used.length === 0) return null;
  await enqueueEmail(tx, recoveryCodeUsedEmail(user.email, await recoveryCodesLeft(tx, user.id)));
  return 'recovery_code';
}

// ─── Signing in ──────────────────────────────────────────────────

export interface TwoFactorPending {
  two_factor: {
    /** verify: enter a code. setup: the organization requires it; set it up now. */
    step: 'verify' | 'setup';
    /** Single use; goes back with the code, from the same device. */
    challenge: string;
    expires_in: number;
  };
}

/** What every sign-in returns: a session, or the step still needed for one. */
export type SignInResult = TokenPair | TwoFactorPending;

export const isPending = (result: SignInResult): result is TwoFactorPending => 'two_factor' in result;

/** SHA-256 of a device public key: ties a half-finished sign-in to the device that started it. */
export const deviceKeyHash = async (key: DevicePublicKey) => Buffer.from(await sha256(`${key.x}.${key.y}`));

/**
 * The one way an existing person gets a session, once their password (or a
 * link sent to their email) checked out. The caller records its own audit
 * entry; a session created here, without a code, is not audited again.
 */
export async function startSignIn(
  tx: Tx,
  userId: string,
  device: SignInDevice,
  meta: RequestMeta,
): Promise<SignInResult> {
  const step = (await hasTwoFactor(tx, userId)) ? 'verify' : (await requirement(tx, userId)) ? 'setup' : null;
  if (!step) return createSession(tx, { userId, ...device, meta });
  const { devicePublicKey } = device;

  const challenge = randomToken();
  await tx.insert(signInChallenges).values({
    user_id: userId,
    token_hash: Buffer.from(await hashToken(challenge)),
    step,
    device_key_hash: await deviceKeyHash(devicePublicKey),
    expires_at: new Date(Date.now() + AUTH.twoFactorChallengeSeconds * 1000),
  });
  return { two_factor: { step, challenge, expires_in: AUTH.twoFactorChallengeSeconds } };
}

/** The open challenge for this token, step and device, locked; null when it is unusable. */
async function lockChallenge(tx: Tx, token: string, step: 'verify' | 'setup', devicePublicKey: DevicePublicKey) {
  const [row] = await tx
    .select()
    .from(signInChallenges)
    .where(
      and(
        eq(signInChallenges.token_hash, Buffer.from(await hashToken(token))),
        isNull(signInChallenges.consumed_at),
        gt(signInChallenges.expires_at, sql`now()`),
      ),
    )
    .for('update');
  if (!row || row.step !== step || row.attempts >= AUTH.twoFactorMaxAttempts) return null;
  // The code must come from the device that entered the password.
  if (!safeEqual(row.device_key_hash, await deviceKeyHash(devicePublicKey))) return null;
  const user = await getUser(tx, row.user_id);
  if (!user || user.status !== 'active') return null;
  return { challenge: row, user };
}

async function countWrongCode(tx: Tx, challengeId: string, userId: string, meta: RequestMeta) {
  await tx
    .update(signInChallenges)
    .set({ attempts: sql`${signInChallenges.attempts} + 1` })
    .where(eq(signInChallenges.id, challengeId));
  await recordAudit(tx, { action: 'auth.two_factor_failed', actorUserId: userId }, meta);
}

const consume = (tx: Tx, challengeId: string) =>
  tx.update(signInChallenges).set({ consumed_at: sql`now()` }).where(eq(signInChallenges.id, challengeId));

/** Who a challenge is for, read without locking: the failure counter is checked before the real work. */
async function challengeEmail(token: string): Promise<string | null> {
  return withIam(async (tx) => {
    const [row] = await tx
      .select({ userId: signInChallenges.user_id })
      .from(signInChallenges)
      .where(eq(signInChallenges.token_hash, Buffer.from(await hashToken(token))));
    return row ? ((await getUser(tx, row.userId))?.email ?? null) : null;
  });
}

/**
 * Wrong codes share the sign-in failure counter of the account, so codes
 * cannot be guessed any faster than passwords. Returns the counter's key.
 */
async function assertNotLockedOut(email: string): Promise<string> {
  const failKey = `login-fail:${email}`;
  const failures = await attempts(failKey, RATE_LIMITS.loginFailuresPerEmail);
  if (failures.count >= RATE_LIMITS.loginFailuresPerEmail[0]) {
    throw new AppError('RATE_LIMITED', 'Too many failed attempts. Try again later.', { retry_after: failures.retryAfter });
  }
  return failKey;
}

async function guardCodeAttempt(input: { challenge: string; device_public_key: DevicePublicKey }, meta: RequestMeta) {
  if (!(await isUsableDeviceKey(input.device_public_key))) throw SIGN_IN_EXPIRED();
  await rateLimit(`login:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.loginPerIp);
  const email = await challengeEmail(input.challenge);
  if (!email) throw SIGN_IN_EXPIRED();
  return assertNotLockedOut(email);
}

type Outcome<T> = { ok: T } | { fail: 'expired' | 'code' };

/** A wrong code commits (it counts), so the transaction returns failures instead of throwing. */
async function settle<T>(failKey: string, outcome: Outcome<T>): Promise<T> {
  if ('ok' in outcome) {
    await resetLimit(failKey);
    return outcome.ok;
  }
  if (outcome.fail === 'expired') throw SIGN_IN_EXPIRED();
  await withinLimit(failKey, RATE_LIMITS.loginFailuresPerEmail);
  throw INCORRECT_CODE();
}

/** Second step of signing in: the code from the app, or a recovery code. */
export async function verifySignIn(input: z.infer<typeof signInCodeSchema>, meta: RequestMeta): Promise<TokenPair> {
  const failKey = await guardCodeAttempt(input, meta);
  const outcome = await withIam(async (tx): Promise<Outcome<TokenPair>> => {
    const open = await lockChallenge(tx, input.challenge, 'verify', input.device_public_key);
    if (!open) return { fail: 'expired' };
    const method = await useSecondFactor(tx, open.user, input.code);
    if (!method) {
      await countWrongCode(tx, open.challenge.id, open.user.id, meta);
      return { fail: 'code' };
    }
    await consume(tx, open.challenge.id);
    await recordAudit(tx, { action: 'auth.login', actorUserId: open.user.id, changes: { two_factor: method } }, meta);
    if (method === 'recovery_code') await recordAudit(tx, { action: 'auth.recovery_code_used', actorUserId: open.user.id }, meta);
    return {
      ok: await createSession(tx, {
        userId: open.user.id,
        devicePublicKey: input.device_public_key,
        browserId: input.browser_id,
        meta,
      }),
    };
  });
  return settle(failKey, outcome);
}

/** Required but not set up: a secret for the app, during sign-in. */
export async function startSetupAtSignIn(input: z.infer<typeof signInSetupSchema>, meta: RequestMeta): Promise<{ secret: string }> {
  if (!(await isUsableDeviceKey(input.device_public_key))) throw SIGN_IN_EXPIRED();
  await rateLimit(`login:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.loginPerIp);
  const secret = await withIam(async (tx) => {
    const open = await lockChallenge(tx, input.challenge, 'setup', input.device_public_key);
    if (!open || (await hasTwoFactor(tx, open.user.id))) return null;
    return newPendingFactor(tx, open.user.id);
  });
  if (!secret) throw SIGN_IN_EXPIRED();
  return { secret };
}

/** Finishes a required setup with the first code: two-factor on, recovery codes, and the session. */
export async function finishSetupAtSignIn(
  input: z.infer<typeof signInCodeSchema>,
  meta: RequestMeta,
): Promise<TokenPair & { recovery_codes: string[] }> {
  const failKey = await guardCodeAttempt(input, meta);
  const outcome = await withIam(async (tx): Promise<Outcome<TokenPair & { recovery_codes: string[] }>> => {
    const open = await lockChallenge(tx, input.challenge, 'setup', input.device_public_key);
    if (!open) return { fail: 'expired' };
    if (!(await confirmPendingFactor(tx, open.user.id, input.code.trim()))) {
      await countWrongCode(tx, open.challenge.id, open.user.id, meta);
      return { fail: 'code' };
    }
    const codes = await replaceRecoveryCodes(tx, open.user.id);
    await consume(tx, open.challenge.id);
    await recordAudit(tx, { action: 'auth.two_factor_enabled', actorUserId: open.user.id }, meta);
    await recordAudit(tx, { action: 'auth.login', actorUserId: open.user.id, changes: { two_factor: 'totp' } }, meta);
    await enqueueEmail(tx, twoFactorEnabledEmail(open.user.email));
    const pair = await createSession(tx, {
      userId: open.user.id,
      devicePublicKey: input.device_public_key,
      browserId: input.browser_id,
      meta,
    });
    return { ok: { ...pair, recovery_codes: codes } };
  });
  return settle(failKey, outcome);
}

// ─── Your own two-factor (Account page) ──────────────────────────

export interface TwoFactorStatus {
  enabled: boolean;
  enabled_at: Date | null;
  recovery_codes_left: number;
  /** The organization requires it for you: it cannot be turned off. */
  required: boolean;
}

export async function twoFactorStatus(auth: AuthContext): Promise<TwoFactorStatus> {
  return withIam(async (tx) => {
    const factor = await factorOf(tx, auth.userId);
    const enabled = Boolean(factor?.confirmed_at);
    return {
      enabled,
      enabled_at: factor?.confirmed_at ?? null,
      recovery_codes_left: enabled ? await recoveryCodesLeft(tx, auth.userId) : 0,
      required: await requirement(tx, auth.userId),
    };
  });
}

async function signedInUser(auth: AuthContext) {
  const user = await withIam((tx) => getUser(tx, auth.userId));
  if (!user) throw new AppError('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
  return user;
}

/** Step 1 of turning it on: your password again, then a secret for the app. */
export async function beginTwoFactorSetup(auth: AuthContext, input: z.infer<typeof passwordOnlySchema>): Promise<{ secret: string }> {
  const user = await signedInUser(auth);
  await assertCurrentPassword(user, input.password, 'password');
  return withIam(async (tx) => {
    if (await hasTwoFactor(tx, user.id)) throw new AppError('CONFLICT', 'Two-factor sign-in is already on.');
    return { secret: await newPendingFactor(tx, user.id) };
  });
}

/** Step 2: the first code from the app proves it works. Returns the recovery codes, once. */
export async function confirmTwoFactorSetup(
  auth: AuthContext,
  input: z.infer<typeof codeOnlySchema>,
  meta: RequestMeta,
): Promise<{ recovery_codes: string[] }> {
  const user = await signedInUser(auth);
  const failKey = await assertNotLockedOut(user.email);
  const outcome = await withIam(async (tx): Promise<Outcome<string[]>> => {
    if (!(await confirmPendingFactor(tx, user.id, input.code.trim()))) return { fail: 'code' };
    const codes = await replaceRecoveryCodes(tx, user.id);
    await recordAudit(tx, { action: 'auth.two_factor_enabled', actorUserId: user.id }, meta);
    await enqueueEmail(tx, twoFactorEnabledEmail(user.email));
    return { ok: codes };
  });
  return { recovery_codes: await settle(failKey, outcome) };
}

/** Needs your password and a code; refused while the organization requires it for you. */
export async function disableTwoFactor(auth: AuthContext, input: z.infer<typeof disableTwoFactorSchema>, meta: RequestMeta) {
  const user = await signedInUser(auth);
  await assertCurrentPassword(user, input.password, 'password');
  const failKey = await assertNotLockedOut(user.email);
  const outcome = await withIam(async (tx): Promise<Outcome<true>> => {
    if (await requirement(tx, user.id)) {
      throw new AppError(
        'CONFLICT',
        "Your organization requires two-factor sign-in, so it can't be turned off. If you lose your phone, an admin can reset it.",
      );
    }
    if (!(await useSecondFactor(tx, user, input.code))) return { fail: 'code' };
    await tx.delete(totpFactors).where(eq(totpFactors.user_id, user.id));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.user_id, user.id));
    await recordAudit(tx, { action: 'auth.two_factor_disabled', actorUserId: user.id }, meta);
    await enqueueEmail(tx, twoFactorDisabledEmail(user.email));
    return { ok: true };
  });
  await settle(failKey, outcome);
}

/** A new set of recovery codes (the old ones stop working); needs a code. */
export async function regenerateRecoveryCodes(
  auth: AuthContext,
  input: z.infer<typeof codeOnlySchema>,
  meta: RequestMeta,
): Promise<{ recovery_codes: string[] }> {
  const user = await signedInUser(auth);
  const failKey = await assertNotLockedOut(user.email);
  const outcome = await withIam(async (tx): Promise<Outcome<string[]>> => {
    if (!(await useSecondFactor(tx, user, input.code))) return { fail: 'code' };
    const codes = await replaceRecoveryCodes(tx, user.id);
    await recordAudit(tx, { action: 'auth.recovery_codes_regenerated', actorUserId: user.id }, meta);
    await enqueueEmail(tx, recoveryCodesReplacedEmail(user.email));
    return { ok: codes };
  });
  return { recovery_codes: await settle(failKey, outcome) };
}

/**
 * For other sensitive changes while signed in (changing your email): when
 * two-factor is on, a code (or recovery code) is needed as well as the
 * password, and is used up. Wrong codes count like wrong passwords.
 */
export async function assertSecondFactorIfOn(user: { id: string; email: string }, code: string | undefined): Promise<void> {
  const failKey = await assertNotLockedOut(user.email);
  const outcome = await withIam(async (tx): Promise<Outcome<true> | 'off'> => {
    if (!(await hasTwoFactor(tx, user.id))) return 'off';
    if (!code) throw new AppError('VALIDATION', 'Some fields are invalid.', { code: 'Enter a code from your app' });
    return (await useSecondFactor(tx, user, code)) ? { ok: true } : { fail: 'code' };
  });
  if (outcome !== 'off') await settle(failKey, outcome);
}

// ─── For administrators (the caller has checked who may) ─────────

/**
 * Lost phone and recovery codes: two-factor off, every session ended. They
 * sign in with their password again (and set it up again if it is required).
 * False when they had none.
 */
export async function resetTwoFactor(tx: Tx, userId: string): Promise<boolean> {
  const removed = await tx.delete(totpFactors).where(eq(totpFactors.user_id, userId)).returning({ id: totpFactors.user_id });
  await tx.delete(recoveryCodes).where(eq(recoveryCodes.user_id, userId));
  await tx.delete(signInChallenges).where(eq(signInChallenges.user_id, userId));
  if (removed.length === 0) return false;
  await revokeUserSessions(tx, userId, 'two_factor_reset');
  return true;
}

// ─── Housekeeping ────────────────────────────────────────────────

/** Challenges that finished or ran out, and setups never finished. */
export async function cleanUpTwoFactor(tx: Tx): Promise<{ challenges: number; pendingFactors: number }> {
  const cutoff = new Date(Date.now() - RETENTION.signInChallengesSeconds * 1000);
  const challenges = await tx
    .delete(signInChallenges)
    .where(or(lt(signInChallenges.expires_at, cutoff), lt(signInChallenges.consumed_at, cutoff)))
    .returning({ id: signInChallenges.id });
  const pendingFactors = await tx
    .delete(totpFactors)
    .where(and(isNull(totpFactors.confirmed_at), lt(totpFactors.created_at, cutoff)))
    .returning({ id: totpFactors.user_id });
  return { challenges: challenges.length, pendingFactors: pendingFactors.length };
}
