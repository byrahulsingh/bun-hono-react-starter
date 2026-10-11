/**
 * Auth email content: the words only. The branded layout (logo, product name,
 * sender) is applied when the outbox sends it.
 */

import { env } from '#/libs/env';
import type { EmailContent } from '#/modules/notifications';

export function passwordResetEmail(to: string, token: string): EmailContent {
  return {
    to,
    subject: 'Reset your password',
    paragraphs: ['Someone asked to reset the password for this account.'],
    action: { label: 'Choose a new password', url: `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}` },
    note: 'The link works once and expires in 1 hour. If this was not you, ignore this email: your password stays the same.',
  };
}

export function passwordChangedEmail(to: string): EmailContent {
  return {
    to,
    subject: 'Your password was changed',
    paragraphs: ['The password for this account was just changed, and other devices were signed out.'],
    action: { label: 'If this was not you, reset your password now', url: `${env.APP_URL}/forgot-password` },
  };
}

const accountLink = () => `${env.APP_URL}/`;

export function twoFactorEnabledEmail(to: string): EmailContent {
  return {
    to,
    subject: 'Two-factor sign-in is on',
    paragraphs: [
      'Two-factor sign-in was just turned on for this account. From now on, signing in needs your password and a code from your authenticator app.',
      'Keep your recovery codes somewhere safe: they are the way back in if you lose your phone.',
    ],
    note: 'If this was not you, reset your password and tell your administrator.',
  };
}

export function twoFactorDisabledEmail(to: string): EmailContent {
  return {
    to,
    subject: 'Two-factor sign-in is off',
    paragraphs: ['Two-factor sign-in was just turned off for this account. Signing in now needs only your password.'],
    action: { label: 'If this was not you, reset your password now', url: `${env.APP_URL}/forgot-password` },
  };
}

export function recoveryCodeUsedEmail(to: string, remaining: number): EmailContent {
  return {
    to,
    subject: 'A recovery code was used to sign in',
    paragraphs: [
      'Someone just signed in to this account with one of its recovery codes instead of an authenticator app code.',
      remaining > 0
        ? `${remaining} recovery code${remaining === 1 ? '' : 's'} left. You can make a new set on your Account page.`
        : 'That was the last one. Make a new set on your Account page now.',
    ],
    action: { label: 'Open your account', url: accountLink() },
    note: 'If this was not you, reset your password and tell your administrator.',
  };
}

export function recoveryCodesReplacedEmail(to: string): EmailContent {
  return {
    to,
    subject: 'New recovery codes were made',
    paragraphs: ['A new set of recovery codes was just made for this account. The old ones no longer work.'],
    note: 'If this was not you, reset your password and tell your administrator.',
  };
}

/** n…@example.com: enough to recognise, without handing the whole address to whoever reads the old mailbox. */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email[0]}…${email.slice(at)}` : email;
}

export function confirmEmailChangeEmail(to: string, token: string): EmailContent {
  return {
    to,
    subject: 'Confirm your new sign-in email',
    paragraphs: ['Someone asked to use this address to sign in, instead of the one they use now.'],
    action: { label: 'Use this email', url: `${env.APP_URL}/confirm-email?token=${encodeURIComponent(token)}` },
    note: 'The link works once and expires in 24 hours. If this was not you, ignore this email: nothing changes.',
  };
}

export function emailChangedEmail(to: string, newEmail: string): EmailContent {
  return {
    to,
    subject: 'Your sign-in email was changed',
    paragraphs: [
      `The email for signing in to this account was just changed to ${maskEmail(newEmail)}. This address no longer works for signing in.`,
    ],
    note: 'If this was not you, tell your administrator now.',
  };
}

export interface NewSignIn {
  device: string;
  ip: string | null;
  at: Date;
}

const signInTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

export function newDeviceEmail(to: string, signIn: NewSignIn, token: string): EmailContent {
  return {
    to,
    subject: 'New sign-in to your account',
    paragraphs: [
      'Your account was just signed in to from a device or browser it has not been used on before.',
      [signIn.device, signIn.ip, `${signInTime.format(signIn.at)} UTC`].filter(Boolean).join(' · '),
      'If this was you, there is nothing to do.',
    ],
    action: { label: "This wasn't me", url: `${env.APP_URL}/sign-in-alert?token=${encodeURIComponent(token)}` },
    note: 'The link signs that device out and works for 7 days. Then change your password.',
  };
}

export function ssoRequiredEmail(to: string, connectionName: string): EmailContent {
  return {
    to,
    subject: 'How to sign in',
    paragraphs: [
      `Someone asked to reset the password for this account. Your organization signs in with ${connectionName}, so there is no password to reset here.`,
      'Use "Sign in with SSO" on the sign-in page, with this email address.',
    ],
    action: { label: 'Sign in with SSO', url: `${env.APP_URL}/sso` },
    note: 'If this was not you, ignore this email.',
  };
}
