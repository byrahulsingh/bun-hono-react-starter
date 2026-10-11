/**
 * Auth timings and limits in one place; change them here only.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const AUTH = {
  /** Access token lifetime. Short, because it cannot be recalled (the session check per request covers revocation). */
  accessTokenSeconds: 10 * MINUTE,
  /** A session with no refresh for this long is over. */
  sessionIdleSeconds: 7 * DAY,
  /** A session is over after this, whatever happens. */
  sessionMaxSeconds: 30 * DAY,
  /** How old a device proof may be. */
  deviceProofMaxAgeSeconds: 60,
  /** How long a "session is alive" answer is cached per API process. */
  sessionCheckCacheSeconds: 15,

  setupTokenSeconds: DAY,
  recoveryTokenSeconds: HOUR,
  invitationSeconds: 7 * DAY,
  /** The link that confirms a new sign-in email. */
  emailChangeSeconds: DAY,
  /** The "this wasn't me" link in a new-device email. */
  signInAlertSeconds: 7 * DAY,

  /** The key that signs access tokens is replaced this often (the worker checks hourly). */
  signingKeyRotationSeconds: 30 * DAY,

  /** From a correct password to the code (or to finishing a required setup). */
  twoFactorChallengeSeconds: 10 * MINUTE,
  /** Wrong codes allowed per sign-in before the password must be entered again. */
  twoFactorMaxAttempts: 5,
  recoveryCodeCount: 10,

  /** From leaving for the SSO provider to coming back with its answer. */
  ssoAttemptSeconds: 10 * MINUTE,

  passwordMinLength: 10,
  /** argon2 work grows with input length; a cap stops huge "passwords" being used to burn CPU. */
  passwordMaxLength: 128,
} as const;

/**
 * How long finished rows stay before the worker deletes them. Long enough to
 * look into an incident; the audit log keeps the history regardless.
 */
export const RETENTION = {
  /** Sessions that ended (signed out, revoked, expired). */
  endedSessionsSeconds: 30 * DAY,
  /** Setup and reset links that were used or expired. */
  usedLinksSeconds: 7 * DAY,
  /** Retired signing keys; they stop verifying after one token lifetime anyway. */
  retiredKeysSeconds: 7 * DAY,
  /** Two-factor sign-in steps that finished or ran out, and setups never finished. */
  signInChallengesSeconds: DAY,
  /** A browser not used to sign in for this long counts as new again. */
  knownDevicesSeconds: 365 * DAY,
  /** Rate-limit windows are at most 15 minutes; a day is plenty. */
  rateLimitWindowsSeconds: DAY,
} as const;

/** [max attempts, window in seconds] */
export const RATE_LIMITS = {
  loginPerIp: [30, 5 * MINUTE],
  /** Failed sign-ins per email; then a cooldown for the rest of the window. */
  loginFailuresPerEmail: [5, 15 * MINUTE],
  refreshPerSession: [30, MINUTE],
  /** Generous: a whole office can share one IP. */
  refreshPerIp: [600, 5 * MINUTE],
  forgotPerIp: [30, 5 * MINUTE],
  /** Silently ignored beyond this, so the answer never differs for real accounts. */
  forgotPerEmail: [1, MINUTE],
  linkPerIp: [30, 5 * MINUTE],
  /** Starting and finishing SSO sign-ins (each start calls the provider). */
  ssoPerIp: [30, 5 * MINUTE],
  /** Each request sends an email to an address of the caller's choosing. */
  emailChangePerUser: [5, HOUR],
} as const satisfies Record<string, readonly [number, number]>;
