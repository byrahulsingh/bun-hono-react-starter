/**
 * argon2id through Bun's built-in implementation (Bun.password); the hash
 * string carries its own salt and parameters, so they can change later
 * without breaking existing hashes.
 */

import { AppError } from '#/libs/errors';

import { RATE_LIMITS } from './iam.config';
import { attempts, withinLimit } from './rate-limit';

let dummyHash: Promise<string> | null = null;

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' });
}

/**
 * Always does the same amount of work: with no hash (unknown email, or an
 * account without a password) it verifies against a dummy hash, so response
 * time does not reveal whether an email has an account.
 */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  dummyHash ??= hashPassword('dummy password for constant-time checks');
  const target = hash ?? (await dummyHash);
  const ok = await Bun.password.verify(password, target);
  return hash ? ok : false;
}

/**
 * For actions that ask for the password again while signed in (changing it,
 * turning two-factor on or off). Shares the sign-in failure counter, so a
 * stolen access token is no way to guess the password.
 */
export async function assertCurrentPassword(
  user: { email: string; password_hash: string | null },
  password: string,
  field = 'current_password',
): Promise<void> {
  const failKey = `login-fail:${user.email}`;
  const failures = await attempts(failKey, RATE_LIMITS.loginFailuresPerEmail);
  if (failures.count >= RATE_LIMITS.loginFailuresPerEmail[0]) {
    throw new AppError('RATE_LIMITED', 'Too many failed attempts. Try again later.', { retry_after: failures.retryAfter });
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    await withinLimit(failKey, RATE_LIMITS.loginFailuresPerEmail);
    throw new AppError('VALIDATION', 'Some fields are invalid.', { [field]: 'Incorrect password' });
  }
}
