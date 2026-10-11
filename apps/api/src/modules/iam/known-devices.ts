/**
 * "New sign-in to your account" emails.
 *
 * Each browser keeps a random id that outlives sign-out (the client's
 * lib/auth/storage.ts); every sign-in sends it along. A session created for a
 * browser this person has not used before emails them, with a link that
 * signs that session out. The very first browser we learn about for someone
 * (setup, an accepted invitation, their first sign-in after this shipped) is
 * not reported: there is nothing to compare it with.
 *
 * The id only ever spares an email. A sign-in without one counts as a new
 * browser, so leaving it out (a script, a private window) changes nothing
 * except that the person hears about it.
 */

import { and, count, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { withIam } from '#/db/db';
import { knownDevices, sessions, signInAlerts } from '#/db/schema';
import { hashToken, randomToken } from '#/libs/crypto';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import { enqueueEmail } from '#/modules/notifications';

import { AUTH, RATE_LIMITS, RETENTION } from './iam.config';
import { newDeviceEmail } from './iam.emails';
import type { linkTokenSchema } from './iam.validators';
import { rateLimit } from './rate-limit';
import { revokeSession } from './sessions';
import { describeUserAgent } from './user-agent';
import { getUser } from './users';

const browserHash = async (browserId: string) => Buffer.from(await hashToken(`browser:${browserId}`));

/**
 * Called by createSession for every new session. Remembers the browser, and
 * emails the person when it is new to them.
 */
export async function noteSignIn(
  tx: Tx,
  input: { userId: string; sessionId: string; browserId?: string | null; meta: RequestMeta },
): Promise<void> {
  const hash = input.browserId ? await browserHash(input.browserId) : null;

  if (hash) {
    const seen = await tx
      .update(knownDevices)
      .set({ last_seen_at: sql`now()`, user_agent: input.meta.userAgent })
      .where(and(eq(knownDevices.user_id, input.userId), eq(knownDevices.browser_hash, hash)))
      .returning({ id: knownDevices.id });
    if (seen.length > 0) return;
  }

  const [known] = await tx.select({ n: count() }).from(knownDevices).where(eq(knownDevices.user_id, input.userId));
  if (hash) {
    await tx
      .insert(knownDevices)
      .values({ user_id: input.userId, browser_hash: hash, user_agent: input.meta.userAgent })
      .onConflictDoNothing();
  }
  // The first browser we learn about: nothing to compare it with.
  if ((known?.n ?? 0) === 0) return;

  const user = await getUser(tx, input.userId);
  if (!user) return;
  const token = randomToken();
  await tx.insert(signInAlerts).values({
    user_id: input.userId,
    session_id: input.sessionId,
    browser_hash: hash,
    user_agent: input.meta.userAgent,
    ip: input.meta.ip,
    token_hash: Buffer.from(await hashToken(token)),
    expires_at: new Date(Date.now() + AUTH.signInAlertSeconds * 1000),
  });
  await enqueueEmail(
    tx,
    newDeviceEmail(user.email, { device: describeUserAgent(input.meta.userAgent), ip: input.meta.ip, at: new Date() }, token),
  );
}

// ─── "This wasn't me" (the link in the email; no sign-in needed) ─

export interface SignInAlertPreview {
  /** The User-Agent of the sign-in; the client turns it into "Chrome on macOS". */
  user_agent: string | null;
  ip: string | null;
  signed_in_at: Date;
  /** False when that session has already ended. */
  session_active: boolean;
}

async function openAlert(tx: Tx, token: string, opts: { lock?: boolean } = {}) {
  const query = tx
    .select({ alert: signInAlerts, revokedAt: sessions.revoked_at })
    .from(signInAlerts)
    .innerJoin(sessions, eq(sessions.id, signInAlerts.session_id))
    .where(
      and(
        eq(signInAlerts.token_hash, Buffer.from(await hashToken(token))),
        isNull(signInAlerts.reported_at),
        gt(signInAlerts.expires_at, sql`now()`),
      ),
    );
  const [row] = opts.lock ? await query.for('update', { of: signInAlerts }) : await query;
  return row;
}

const ALERT_INVALID = () =>
  new AppError('LINK_INVALID', 'This link has expired or was already used. Sign in and check your devices on the Account page.');

/** What the link is about, shown before the person confirms. */
export async function previewSignInAlert(input: z.infer<typeof linkTokenSchema>, meta: RequestMeta): Promise<SignInAlertPreview> {
  await rateLimit(`link:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.linkPerIp);
  const row = await withIam((tx) => openAlert(tx, input.token));
  if (!row) throw ALERT_INVALID();
  return {
    user_agent: row.alert.user_agent,
    ip: row.alert.ip,
    signed_in_at: row.alert.created_at,
    session_active: row.revokedAt === null,
  };
}

/**
 * Signs that session out and forgets the browser, so signing in from it again
 * emails the person again. The link works once.
 */
export async function reportSignInAlert(input: z.infer<typeof linkTokenSchema>, meta: RequestMeta): Promise<void> {
  await rateLimit(`link:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.linkPerIp);
  await withIam(async (tx) => {
    const row = await openAlert(tx, input.token, { lock: true });
    if (!row) throw ALERT_INVALID();
    const { alert } = row;
    await tx.update(signInAlerts).set({ reported_at: sql`now()` }).where(eq(signInAlerts.id, alert.id));
    await revokeSession(tx, alert.session_id, 'reported_by_user');
    if (alert.browser_hash) {
      await tx
        .delete(knownDevices)
        .where(and(eq(knownDevices.user_id, alert.user_id), eq(knownDevices.browser_hash, alert.browser_hash)));
    }
    await recordAudit(
      tx,
      { action: 'auth.sign_in_reported', actorUserId: alert.user_id, targetType: 'session', targetId: alert.session_id },
      meta,
    );
  });
}

// ─── Housekeeping ────────────────────────────────────────────────

/** Browsers not used for a long time, and alerts past their link's life. */
export async function cleanUpKnownDevices(tx: Tx): Promise<{ knownDevices: number; signInAlerts: number }> {
  const devices = await tx
    .delete(knownDevices)
    .where(lt(knownDevices.last_seen_at, new Date(Date.now() - RETENTION.knownDevicesSeconds * 1000)))
    .returning({ id: knownDevices.id });
  const linksCutoff = new Date(Date.now() - RETENTION.usedLinksSeconds * 1000);
  const alerts = await tx
    .delete(signInAlerts)
    .where(or(lt(signInAlerts.expires_at, linksCutoff), lt(signInAlerts.reported_at, linksCutoff)))
    .returning({ id: signInAlerts.id });
  return { knownDevices: devices.length, signInAlerts: alerts.length };
}
