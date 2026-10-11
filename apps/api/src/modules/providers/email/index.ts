/**
 * The email registry: which adapter sends, from which settings.
 *
 *   1. the server's environment (SMTP_HOST, …): always wins
 *   2. the dashboard (Settings → Email, saved in provider_settings)
 *   3. development with neither: Mailpit from compose.yaml
 *   4. production with neither: a sender that fails with a clear message, so
 *      the outbox records it and Settings → Email shows what to do
 *
 * The API and the worker are separate processes: a save in one reaches the
 * other through the setting's version, checked every few seconds while
 * emails are being sent.
 */

import { env, isProd } from '#/libs/env';
import { providerSettingVersion, readProviderSetting } from '#/modules/providers/settings-store';

import type { EmailSender } from './email.port';
import type { SmtpConfig } from './smtp.adapter';
import { smtpSender } from './smtp.adapter';

export const EMAIL_SETTING_KEY = 'email';
/** How long a sender is used before checking whether the dashboard settings changed. */
const RECHECK_MS = 5_000;

/** The dashboard's mail server settings, as stored (the password apart, encrypted). */
export interface StoredEmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  from: string;
}
export interface StoredEmailSecret {
  password: string;
}

export type EmailSource = 'environment' | 'dashboard' | 'development' | 'none';

const NOT_SET_UP =
  'Email is not set up. An owner can enter the mail server in Settings → Email, or set SMTP_HOST and MAIL_FROM in the server environment.';

function envConfig(): SmtpConfig {
  return {
    host: env.SMTP_HOST ?? 'localhost',
    port: env.SMTP_PORT ?? (env.SMTP_HOST ? 587 : 1025),
    secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.MAIL_FROM ?? 'no-reply@localhost',
  };
}

interface Resolved {
  source: EmailSource;
  config: SmtpConfig | null;
  version: string;
}

async function resolve(): Promise<Resolved> {
  if (env.SMTP_HOST) return { source: 'environment', config: envConfig(), version: 'environment' };
  const stored = await readProviderSetting<StoredEmailConfig, StoredEmailSecret>(EMAIL_SETTING_KEY);
  if (stored) {
    const { user, ...rest } = stored.config;
    return {
      source: 'dashboard',
      config: { ...rest, user: user ?? undefined, password: stored.secret?.password },
      version: stored.updated_at.toISOString(),
    };
  }
  if (!isProd) return { source: 'development', config: envConfig(), version: 'development' };
  return { source: 'none', config: null, version: 'none' };
}

/** Fails every send with what to do: emails wait in the outbox and show up in Settings → Email. */
function notSetUpSender(): EmailSender {
  return {
    name: 'none',
    async send() {
      throw new Error(NOT_SET_UP);
    },
    async verify() {
      throw new Error(NOT_SET_UP);
    },
  };
}

let override: EmailSender | null = null;
let cached: { sender: EmailSender; version: string; checkedAt: number } | null = null;

async function currentVersion(): Promise<string> {
  if (env.SMTP_HOST) return 'environment';
  return (await providerSettingVersion(EMAIL_SETTING_KEY)) ?? (isProd ? 'none' : 'development');
}

export async function emailSender(): Promise<EmailSender> {
  if (override) return override;
  if (cached && Date.now() - cached.checkedAt < RECHECK_MS) return cached.sender;
  if (cached && cached.version === (await currentVersion())) {
    cached.checkedAt = Date.now();
    return cached.sender;
  }
  const resolved = await resolve();
  cached?.sender.close?.();
  cached = {
    sender: resolved.config ? smtpSender(resolved.config) : notSetUpSender(),
    version: resolved.version,
    checkedAt: Date.now(),
  };
  return cached.sender;
}

/** After a save in this process: the next send uses the new settings at once. */
export function forgetEmailSender() {
  cached?.sender.close?.();
  cached = null;
}

/** A one-off sender for settings not saved yet ("Test connection"). Close it after use. */
export function smtpSenderFor(config: SmtpConfig): EmailSender {
  return smtpSender(config);
}

/** What the settings page may show about the email setup. Never the password. */
export interface EmailConfigSummary {
  /**
   * environment: SMTP_* in the server's environment (read-only here).
   * dashboard: saved in Settings → Email. development: nothing set, Mailpit.
   * none: production with nothing set; emails cannot go out.
   */
  source: EmailSource;
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  password_set: boolean;
  from: string | null;
}

export async function emailConfigSummary(): Promise<EmailConfigSummary> {
  const { source, config } = await resolve();
  return {
    source,
    host: config?.host ?? null,
    port: config?.port ?? null,
    secure: config?.secure ?? false,
    user: config?.user ?? null,
    password_set: Boolean(config?.password),
    from: config?.from ?? null,
  };
}

/** The dashboard's saved settings, for filling the form (password left out). */
export async function storedEmailSettings(): Promise<{ config: StoredEmailConfig; password: string | null } | null> {
  const stored = await readProviderSetting<StoredEmailConfig, StoredEmailSecret>(EMAIL_SETTING_KEY);
  return stored && { config: stored.config, password: stored.secret?.password ?? null };
}

/** Tests: send through `replacement` instead (e.g. memorySender()). */
export function useEmailSender(replacement: EmailSender | null) {
  override = replacement;
  forgetEmailSender();
}

export type { EmailMessage, EmailSender } from './email.port';
export type { SmtpConfig } from './smtp.adapter';
export { memorySender } from './memory.adapter';
