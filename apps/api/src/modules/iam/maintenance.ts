/**
 * The iam module's background upkeep, run by the worker (modules/maintenance):
 * rotate the token signing key when it is due, and delete finished rows.
 * Safe to run on several workers at once: deletes are idempotent, and two
 * rotations at the same moment resolve to one (signing-keys.ts).
 */

import { and, desc, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { withIam } from '#/db/db';
import { emailChanges, oneTimeTokens, rateLimits, sessions, signingKeys } from '#/db/schema';

import { AUTH, RETENTION } from './iam.config';
import { cleanUpKnownDevices } from './known-devices';
import { rotateSigningKey } from './signing-keys';
import { cleanUpSso } from './sso';
import { cleanUpTwoFactor } from './two-factor';

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

/** Rotates when the active key is older than AUTH.signingKeyRotationSeconds. True if it did. */
export async function rotateSigningKeyIfDue(): Promise<boolean> {
  const [active] = await withIam((tx) =>
    tx
      .select({ activated_at: signingKeys.activated_at })
      .from(signingKeys)
      .where(isNull(signingKeys.retired_at))
      .orderBy(desc(signingKeys.activated_at))
      .limit(1),
  );
  // No key yet: the API creates the first one when it first signs a token.
  if (!active || active.activated_at > ago(AUTH.signingKeyRotationSeconds)) return false;
  await rotateSigningKey();
  return true;
}

export interface IamCleanup {
  sessions: number;
  links: number;
  rateLimits: number;
  signingKeys: number;
  signInChallenges: number;
  unfinishedTwoFactorSetups: number;
  emailChanges: number;
  knownDevices: number;
  signInAlerts: number;
  ssoAttempts: number;
}

export async function cleanUpIam(): Promise<IamCleanup> {
  return withIam(async (tx) => {
    const keep = ago(RETENTION.endedSessionsSeconds);
    const deletedSessions = await tx
      .delete(sessions)
      .where(
        or(
          lt(sessions.revoked_at, keep),
          lt(sessions.not_after, keep),
          // Idle-expired: no refresh for the idle limit, then the retention on top.
          lt(sessions.refreshed_at, ago(AUTH.sessionIdleSeconds + RETENTION.endedSessionsSeconds)),
        ),
      )
      .returning({ id: sessions.id });

    const linksCutoff = ago(RETENTION.usedLinksSeconds);
    const deletedLinks = await tx
      .delete(oneTimeTokens)
      .where(or(lt(oneTimeTokens.consumed_at, linksCutoff), lt(oneTimeTokens.expires_at, linksCutoff)))
      .returning({ id: oneTimeTokens.id });

    const deletedWindows = await tx
      .delete(rateLimits)
      .where(lt(rateLimits.window_start, ago(RETENTION.rateLimitWindowsSeconds)))
      .returning({ key: rateLimits.key });

    const deletedKeys = await tx
      .delete(signingKeys)
      .where(and(isNotNull(signingKeys.retired_at), lt(signingKeys.retired_at, ago(RETENTION.retiredKeysSeconds))))
      .returning({ kid: signingKeys.kid });

    const twoFactor = await cleanUpTwoFactor(tx);
    const devices = await cleanUpKnownDevices(tx);
    const ssoAttempts = await cleanUpSso(tx);
    const deletedEmailChanges = await tx
      .delete(emailChanges)
      .where(lt(emailChanges.expires_at, linksCutoff))
      .returning({ id: emailChanges.user_id });

    // Keeps the planner's row estimates honest after large deletes; cheap on small tables.
    if (deletedSessions.length > 1000) await tx.execute(sql`analyze iam.sessions`);

    return {
      sessions: deletedSessions.length,
      links: deletedLinks.length,
      rateLimits: deletedWindows.length,
      signingKeys: deletedKeys.length,
      signInChallenges: twoFactor.challenges,
      unfinishedTwoFactorSetups: twoFactor.pendingFactors,
      emailChanges: deletedEmailChanges.length,
      knownDevices: devices.knownDevices,
      signInAlerts: devices.signInAlerts,
      ssoAttempts,
    };
  });
}
