/**
 * Every error code the API can send, and the one error type routes throw.
 *
 *   throw new AppError('NOT_FOUND', 'Project not found');
 *   throw new AppError('CONFLICT', 'An account with this email already exists');
 *
 * `app.onError` turns it into the envelope:
 *
 *   { success: false, message: 'Project not found', error: { code: 'NOT_FOUND' } }
 *
 * `message` is for people and may change wording at any time. `code` is for
 * the client to branch on, so it is stable: never rename or reuse one. The
 * client keeps its own copy of the codes it cares about
 * (apps/client/src/lib/api/api.ts) — the two apps share no code, only this
 * contract — so a new code here is a note to add it there too.
 *
 * The status belongs to the code, not to the call site, so the same failure
 * can never go out with two different statuses.
 */

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

export const ERROR_CODES = {
  /** Input failed validation. `details` maps each field to its message. */
  VALIDATION: 422,
  /** A request we cannot parse at all, e.g. malformed JSON. */
  BAD_REQUEST: 400,
  /** Not signed in, or the session is no longer valid. */
  UNAUTHORIZED: 401,
  /** Signed in, but not allowed to do this. */
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  /** Clashes with the current state, e.g. a duplicate email. */
  CONFLICT: 409,
  /** Existed once and is gone for good, e.g. an expired link. */
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  /** A dependency is down (database, AI provider); retrying later may work. */
  UNAVAILABLE: 503,

  // Feature codes go below this line, grouped by feature, when the feature is
  // built — e.g. INVITE_EXPIRED: 410.

  // ── Auth ──
  /** Wrong email or password, or a disabled account: deliberately one code for all three. */
  INVALID_CREDENTIALS: 401,
  /** The session ended (signed out, expired, revoked). Sign in again. */
  SESSION_EXPIRED: 401,
  /** A refresh came without a valid proof from this device's key. */
  INVALID_DEVICE_PROOF: 401,
  /** An old refresh token was used again; the session was ended as a precaution. */
  REFRESH_TOKEN_REUSED: 401,
  /** A setup, reset or invitation link that is wrong, used or expired. */
  LINK_INVALID: 410,
  /** A password was used where the organization requires single sign-on: use "Sign in with SSO". */
  SSO_REQUIRED: 403,
} as const satisfies Record<string, ContentfulStatusCode>;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Sent to the client as-is: never put internals (SQL, stack traces) here. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_CODES[code];
  }
}

/**
 * For errors that did not come from our code — Hono's own HTTPExceptions
 * (malformed JSON, body too large) — so they still carry a code. First code
 * listed with that status wins; anything unknown is treated by class.
 */
export function codeForStatus(status: number): ErrorCode {
  const match = (Object.keys(ERROR_CODES) as ErrorCode[]).find((code) => ERROR_CODES[code] === status);
  if (match) return match;
  return status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
}

/**
 * Fallback wording when an error arrives without a message. Hono's own
 * HTTPExceptions often have none (bodyLimit sends ''), and an empty message
 * would reach the user as a blank error.
 */
const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  BAD_REQUEST: 'The request could not be read.',
  UNAUTHORIZED: 'Please sign in to continue.',
  FORBIDDEN: "You don't have permission to do this.",
  NOT_FOUND: 'Not found.',
  PAYLOAD_TOO_LARGE: 'The request is too large.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  UNAVAILABLE: 'The service is temporarily unavailable. Try again shortly.',
};

export function defaultMessage(code: ErrorCode): string {
  return DEFAULT_MESSAGES[code] ?? 'Something went wrong.';
}

/**
 * Zod issues -> `{ field: message }`, the shape forms render next to inputs.
 * Nested paths are dotted (`address.city`, `items.0.name`); a problem with the
 * input as a whole goes under `_`. One message per field — the first — which
 * is what a form can show.
 */
export function validationError(error: z.core.$ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_';
    fields[key] ??= issue.message;
  }
  return new AppError('VALIDATION', 'Some fields are invalid.', fields);
}
