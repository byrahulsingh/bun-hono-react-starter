/**
 * The mail server, set in the dashboard (Settings → Email) when the server's
 * environment does not set one. Owners only (the routes check): whoever
 * chooses the mail server can read every email, password reset links
 * included. Saving checks the connection first, so a typo never stops email.
 */

import { z } from 'zod';

import { withApp } from '#/db/db';
import { AppError } from '#/libs/errors';
import { env } from '#/libs/env';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import type { AuthContext } from '#/modules/iam';
import type { SmtpConfig } from '#/modules/providers/email';
import { EMAIL_SETTING_KEY, forgetEmailSender, smtpSenderFor, storedEmailSettings } from '#/modules/providers/email';
import { deleteProviderSetting, writeProviderSetting } from '#/modules/providers/settings-store';

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:.]+\]?$/;
const NAMED_FROM = /^\s*"?([^"<>]{1,100}?)"?\s*<([^\s<>@]+@[^\s<>@]+)>\s*$/;
const address = z.email();

/** `a@b`, or `Name <a@b>`. */
function validFrom(value: string): boolean {
  const named = NAMED_FROM.exec(value);
  return address.safeParse(named ? named[2] : value.trim()).success;
}

export const emailServerSchema = z.object({
  host: z.string().trim().regex(HOST, 'Enter a host name, like smtp.example.com'),
  port: z.coerce.number().int().min(1, 'Enter a port').max(65535, 'Enter a port'),
  /** tls: TLS from the first byte (usually 465). starttls: upgraded after connecting (usually 587). */
  security: z.enum(['tls', 'starttls']),
  user: z.string().trim().max(320).optional(),
  /** Left out (or empty) when editing: the saved one is kept. */
  password: z.string().max(1000).optional(),
  from: z.string().trim().min(3, 'Required').max(320).refine(validFrom, 'Use an address, or Name <address>'),
});

type EmailServerInput = z.infer<typeof emailServerSchema>;

function assertNotFromEnvironment() {
  if (env.SMTP_HOST) {
    throw new AppError('CONFLICT', 'The mail server is set in the server environment (SMTP_HOST), which wins. Change it there.');
  }
}

/** The settings to use: the typed ones, with the saved password when none was typed. */
async function configFrom(input: EmailServerInput): Promise<SmtpConfig> {
  const user = input.user || undefined;
  const saved = await storedEmailSettings();
  const password = input.password || (user && saved?.config.user === user ? (saved.password ?? undefined) : undefined);
  if (user && !password) {
    throw new AppError('VALIDATION', 'Some fields are invalid.', { password: 'Enter the password for this username' });
  }
  return { host: input.host, port: input.port, secure: input.security === 'tls', user, password: user ? password : undefined, from: input.from };
}

/** Connects and signs in, without sending. The server's own answer when it fails. */
async function check(config: SmtpConfig): Promise<void> {
  const sender = smtpSenderFor(config);
  try {
    await sender.verify();
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 300) : String(err);
    throw new AppError('BAD_REQUEST', `Couldn't connect to ${config.host}:${config.port}: ${reason}`);
  } finally {
    sender.close?.();
  }
}

/** "Test connection": the typed settings, not saved. */
export async function testEmailServer(input: EmailServerInput): Promise<void> {
  assertNotFromEnvironment();
  await check(await configFrom(input));
}

export async function saveEmailServer(auth: AuthContext, input: EmailServerInput, meta: RequestMeta): Promise<void> {
  assertNotFromEnvironment();
  const config = await configFrom(input);
  await check(config);
  const before = await storedEmailSettings();
  await withApp(async (tx) => {
    await writeProviderSetting(tx, EMAIL_SETTING_KEY, {
      config: { host: config.host, port: config.port, secure: config.secure, user: config.user ?? null, from: config.from },
      secret: config.password ? { password: config.password } : null,
      updatedBy: auth.userId,
    });
    await recordAudit(
      tx,
      {
        action: 'email.server_saved',
        actorUserId: auth.userId,
        changes: {
          host: config.host,
          port: config.port,
          security: input.security,
          user: config.user ?? null,
          from: config.from,
          password: input.password ? (before ? 'replaced' : 'set') : 'kept',
        },
      },
      meta,
    );
  });
  forgetEmailSender();
}

/** Back to the environment's settings (or none). */
export async function removeEmailServer(auth: AuthContext, meta: RequestMeta): Promise<void> {
  await withApp(async (tx) => {
    if (!(await deleteProviderSetting(tx, EMAIL_SETTING_KEY))) return;
    await recordAudit(tx, { action: 'email.server_removed', actorUserId: auth.userId }, meta);
  });
  forgetEmailSender();
}
