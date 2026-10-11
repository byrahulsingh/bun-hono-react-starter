import { z } from 'zod';

import { AUTH } from './iam.config';
import { devicePublicKeySchema } from './tokens';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254));

/** Only length rules: they are what actually makes a password hard to guess. */
export const newPasswordSchema = z
  .string()
  .min(AUTH.passwordMinLength, `Use at least ${AUTH.passwordMinLength} characters`)
  .max(AUTH.passwordMaxLength, `Use at most ${AUTH.passwordMaxLength} characters`);

/** For checking an existing password: no length rules, so old passwords still work. */
const passwordInput = z.string().min(1, 'Required').max(AUTH.passwordMaxLength);

/** Single-use tokens from links: 43 base64url characters, anything longer is not ours. */
const linkToken = z.string().min(1, 'Required').max(200);

/**
 * The browser's lasting random id (known-devices.ts), sent with every request
 * that can end in a session. Only ever spares an email, so anything odd is
 * dropped rather than refused: it never blocks a sign-in.
 */
export const browserIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/)
  .optional()
  .catch(undefined);

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordInput,
  device_public_key: devicePublicKeySchema,
  browser_id: browserIdSchema,
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1).max(200),
  proof: z.string().min(1).max(2000),
});

export const logoutSchema = z.object({
  /** this device (default) · every other device · every device */
  scope: z.enum(['local', 'others', 'global']).default('local'),
});

export const changePasswordSchema = z.object({
  current_password: passwordInput,
  new_password: newPasswordSchema,
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: linkToken,
  password: newPasswordSchema,
  device_public_key: devicePublicKeySchema,
  browser_id: browserIdSchema,
});

export const sessionIdParamSchema = z.object({ id: z.uuid('Not found') });

// ─── Two-factor ──────────────────────────────────────────────────

/** 6 digits from the app, or a recovery code (`abcde-fghjk`); spaces are fine. */
const secondFactorCode = z.string().trim().min(1, 'Required').max(32, 'Not a valid code');
const challengeToken = z.string().min(1, 'Required').max(200);

export const signInCodeSchema = z.object({
  challenge: challengeToken,
  code: secondFactorCode,
  device_public_key: devicePublicKeySchema,
  browser_id: browserIdSchema,
});

export const signInSetupSchema = z.object({
  challenge: challengeToken,
  device_public_key: devicePublicKeySchema,
});

export const passwordOnlySchema = z.object({ password: passwordInput });

export const codeOnlySchema = z.object({ code: secondFactorCode });

export const disableTwoFactorSchema = z.object({ password: passwordInput, code: secondFactorCode });

// ─── Changing your email ─────────────────────────────────────────

export const emailChangeSchema = z.object({
  new_email: emailSchema,
  password: passwordInput,
  /** Needed when two-factor is on. */
  code: secondFactorCode.optional(),
});

export const linkTokenSchema = z.object({ token: linkToken });

// ─── Single sign-on ──────────────────────────────────────────────

const ssoState = z.string().min(1, 'Required').max(200);
/** Provider codes vary a lot in length (Microsoft's run past a thousand characters). */
const ssoCode = z.string().min(1, 'Required').max(4096);

export const ssoStartSchema = z.object({
  email: emailSchema,
  device_public_key: devicePublicKeySchema,
  browser_id: browserIdSchema,
});

export const ssoFinishSchema = z.object({
  state: ssoState,
  code: ssoCode,
  device_public_key: devicePublicKeySchema,
  browser_id: browserIdSchema,
});

export const ssoTestFinishSchema = z.object({ state: ssoState, code: ssoCode });

export const ssoConnectionSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(60, 'Use at most 60 characters'),
  issuer: z.string().trim().min(1, 'Required').max(500),
  client_id: z.string().trim().min(1, 'Required').max(500),
  /** Required when creating; left out when editing keeps the stored one. */
  client_secret: z.string().trim().max(2000).optional(),
  domains: z.array(z.string().max(253)).max(50, 'At most 50 domains'),
});

export const ssoRequiredSchema = z.object({ required: z.boolean() });
