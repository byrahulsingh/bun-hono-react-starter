/**
 * Changing your sign-in email. The password (and a code, with two-factor on)
 * starts it; a link sent to the NEW address finishes it, so a typo or an
 * address you cannot read never locks you out. The old address is told once
 * it is done. Other devices stay signed in: the person is the same.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';

import { isUniqueViolation, withIam } from '#/db/db';
import { emailChanges, oneTimeTokens, users } from '#/db/schema';
import { hashToken, randomToken } from '#/libs/crypto';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import { enqueueEmail } from '#/modules/notifications';

import { AUTH, RATE_LIMITS } from './iam.config';
import { confirmEmailChangeEmail, emailChangedEmail } from './iam.emails';
import type { AuthContext } from './iam.service';
import type { emailChangeSchema, linkTokenSchema } from './iam.validators';
import { assertCurrentPassword } from './passwords';
import { rateLimit } from './rate-limit';
import { assertSecondFactorIfOn } from './two-factor';
import { findUserByEmail, getUser } from './users';

const fieldError = (field: string, message: string) => new AppError('VALIDATION', 'Some fields are invalid.', { [field]: message });
const TAKEN = 'Another account uses this email';

export interface PendingEmailChange {
  new_email: string;
  expires_at: Date;
}

/** The change waiting for its link to be opened, if any. */
export async function pendingEmailChange(auth: AuthContext): Promise<PendingEmailChange | null> {
  const [row] = await withIam((tx) =>
    tx
      .select({ new_email: emailChanges.new_email, expires_at: emailChanges.expires_at })
      .from(emailChanges)
      .where(and(eq(emailChanges.user_id, auth.userId), gt(emailChanges.expires_at, sql`now()`))),
  );
  return row ?? null;
}

/** Emails a confirmation link to the new address. Asking again replaces the earlier link. */
export async function requestEmailChange(
  auth: AuthContext,
  input: z.infer<typeof emailChangeSchema>,
  meta: RequestMeta,
): Promise<PendingEmailChange> {
  const user = await withIam((tx) => getUser(tx, auth.userId));
  if (!user) throw new AppError('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
  if (input.new_email === user.email) throw fieldError('new_email', 'This is already your email');

  await rateLimit(`email-change:user:${user.id}`, RATE_LIMITS.emailChangePerUser);
  await assertCurrentPassword(user, input.password, 'password');
  await assertSecondFactorIfOn(user, input.code);

  return withIam(async (tx) => {
    // Said plainly: the caller is signed in and has just given their password.
    if (await findUserByEmail(tx, input.new_email)) throw fieldError('new_email', TAKEN);
    const token = randomToken();
    const pending = {
      new_email: input.new_email,
      expires_at: new Date(Date.now() + AUTH.emailChangeSeconds * 1000),
    };
    await tx.delete(emailChanges).where(eq(emailChanges.user_id, user.id));
    await tx.insert(emailChanges).values({ user_id: user.id, token_hash: Buffer.from(await hashToken(token)), ...pending });
    await enqueueEmail(tx, confirmEmailChangeEmail(input.new_email, token));
    await recordAudit(tx, { action: 'auth.email_change_requested', actorUserId: user.id, changes: { to: input.new_email } }, meta);
    return pending;
  });
}

export async function cancelEmailChange(auth: AuthContext): Promise<void> {
  await withIam((tx) => tx.delete(emailChanges).where(eq(emailChanges.user_id, auth.userId)));
}

/** The link from the new address. Works without being signed in (it may be opened on a phone). */
export async function confirmEmailChange(input: z.infer<typeof linkTokenSchema>, meta: RequestMeta): Promise<{ email: string }> {
  await rateLimit(`link:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.linkPerIp);
  try {
    return await withIam(async (tx) => {
      const [row] = await tx
        .select()
        .from(emailChanges)
        .where(and(eq(emailChanges.token_hash, Buffer.from(await hashToken(input.token))), gt(emailChanges.expires_at, sql`now()`)))
        .for('update');
      const user = row && (await getUser(tx, row.user_id));
      if (!row || !user || user.status !== 'active') {
        throw new AppError('LINK_INVALID', 'This link is invalid or has expired. Ask for a new one from your Account page.');
      }
      if (await findUserByEmail(tx, row.new_email)) {
        throw new AppError('CONFLICT', 'Another account now uses this email, so it could not be changed.');
      }

      await tx.delete(emailChanges).where(eq(emailChanges.user_id, user.id));
      // Opening a link sent to the address proves the person owns it.
      await tx.update(users).set({ email: row.new_email, email_confirmed_at: sql`now()` }).where(eq(users.id, user.id));
      // A reset link already sent to the old address must not outlive the change.
      await tx
        .delete(oneTimeTokens)
        .where(and(eq(oneTimeTokens.user_id, user.id), eq(oneTimeTokens.type, 'recovery'), isNull(oneTimeTokens.consumed_at)));
      await recordAudit(
        tx,
        { action: 'auth.email_changed', actorUserId: user.id, changes: { from: user.email, to: row.new_email } },
        meta,
      );
      await enqueueEmail(tx, emailChangedEmail(user.email, row.new_email));
      return { email: row.new_email };
    });
  } catch (err) {
    // Someone took the address between the check and the update.
    if (isUniqueViolation(err, 'users_email_live')) {
      throw new AppError('CONFLICT', 'Another account now uses this email, so it could not be changed.');
    }
    throw err;
  }
}
