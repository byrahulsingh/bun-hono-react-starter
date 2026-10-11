/**
 * Is email working? The settings (env or dashboard; shown, never the password),
 * a test email goes out right away with the real error if it fails, and the
 * outbox tells which emails failed or are stuck retrying.
 */

import { and, desc, gt, gte, isNotNull, isNull, max, sql } from 'drizzle-orm';

import { withApp, withIam } from '#/db/db';
import { organization, outbox } from '#/db/schema';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import { getBranding } from '#/modules/branding';
import type { AuthContext } from '#/modules/iam';
import { getUser, rateLimit } from '#/modules/iam';
import { renderEmail } from '#/modules/notifications';
import type { EmailConfigSummary } from '#/modules/providers/email';
import { emailConfigSummary, emailSender } from '#/modules/providers/email';

/** Failed emails are listed for this long (the outbox keeps them 30 days). */
const FAILED_WINDOW_DAYS = 7;
/** Retrying after this many failures counts as "delayed"; one blip does not. */
const DELAYED_AFTER_ATTEMPTS = 2;
const TEST_EMAIL_LIMIT = [5, 10 * 60] as const;

export interface EmailProblem {
  id: string;
  recipient: string | null;
  subject: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  /** Given up at (failed), or the next try (delayed). */
  at: Date | null;
}

export interface EmailStatus {
  /** Failed since email last worked (a send, or a test): something is wrong now. */
  failing: number;
  /** Waiting for another try after repeated failures. */
  delayed: number;
}

export interface EmailSettings {
  config: EmailConfigSummary;
  checked_at: Date | null;
  last_sent_at: Date | null;
  failed: EmailProblem[];
  delayed: EmailProblem[];
}

const since = (days: number) => sql`now() - make_interval(days => ${days})`;
const isDelayed = and(isNull(outbox.sent_at), isNull(outbox.failed_at), gte(outbox.attempts, DELAYED_AFTER_ATTEMPTS));

/** Cheap counts for the warning bar in the app. */
export async function emailStatus(): Promise<EmailStatus> {
  return withApp(async (tx) => {
    // Email last worked: an email went out, or a test email was accepted.
    const [last] = await tx.select({ at: max(outbox.sent_at) }).from(outbox);
    const [org] = await tx.select({ checked: organization.email_checked_at }).from(organization);
    const times = [last?.at, org?.checked].filter((t): t is Date => t instanceof Date);
    const lastSent = times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
    const [failing] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(outbox)
      .where(
        and(
          isNotNull(outbox.failed_at),
          gt(outbox.failed_at, since(FAILED_WINDOW_DAYS)),
          lastSent ? gt(outbox.failed_at, lastSent) : undefined,
        ),
      );
    const [delayed] = await tx.select({ n: sql<number>`count(*)::int` }).from(outbox).where(isDelayed);
    return { failing: failing!.n, delayed: delayed!.n };
  });
}

export async function emailSettings(): Promise<EmailSettings> {
  const config = await emailConfigSummary();
  return withApp(async (tx) => {
    const [org] = await tx.select({ checked_at: organization.email_checked_at }).from(organization);
    const [last] = await tx.select({ at: max(outbox.sent_at) }).from(outbox);
    const columns = {
      id: outbox.id,
      recipient: outbox.recipient,
      subject: outbox.subject,
      attempts: outbox.attempts,
      last_error: outbox.last_error,
      created_at: outbox.created_at,
    };
    const failed = await tx
      .select({ ...columns, at: outbox.failed_at })
      .from(outbox)
      .where(and(isNotNull(outbox.failed_at), gt(outbox.failed_at, since(FAILED_WINDOW_DAYS))))
      .orderBy(desc(outbox.failed_at))
      .limit(50);
    const delayed = await tx
      .select({ ...columns, at: outbox.run_after })
      .from(outbox)
      .where(isDelayed)
      .orderBy(outbox.run_after)
      .limit(50);
    return { config, checked_at: org?.checked_at ?? null, last_sent_at: last?.at ?? null, failed, delayed };
  });
}

/**
 * Sends a branded test email to the caller, now, not through the outbox: the
 * point is to see the mail server's answer. Success is remembered (the
 * getting-started checklist); a failure comes back with the server's message.
 */
export async function sendTestEmail(auth: AuthContext, meta: RequestMeta): Promise<{ sent_to: string }> {
  await rateLimit(`email-test:${auth.userId}`, TEST_EMAIL_LIMIT);
  const user = await withIam((tx) => getUser(tx, auth.userId));
  if (!user) throw new AppError('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');

  const brand = await getBranding();
  const message = renderEmail(
    {
      to: user.email,
      subject: `Test email from ${brand.product_name}`,
      paragraphs: [
        `This is a test from the email settings of ${brand.product_name}.`,
        'If you can read it, invitations and password resets will reach people too.',
      ],
    },
    brand,
  );

  try {
    await (await emailSender()).send(message);
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 300) : String(err);
    throw new AppError('UNAVAILABLE', `The mail server did not accept the email: ${reason}`);
  }

  await withApp(async (tx) => {
    const [org] = await tx.update(organization).set({ email_checked_at: sql`now()` }).returning({ id: organization.id });
    await recordAudit(
      tx,
      { action: 'email.test_sent', actorUserId: auth.userId, targetType: 'organization', targetId: org?.id, changes: { to: user.email } },
      meta,
    );
  });
  return { sent_to: user.email };
}
