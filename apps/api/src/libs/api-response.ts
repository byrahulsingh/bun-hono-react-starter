/**
 * The single response envelope for every endpoint.
 *
 * Every route returns this shape, so the client has exactly one thing to parse
 * and one place to look for failure.
 */

import type { ErrorCode } from '#/libs/errors';

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data?: T;
  error?: {
    /** Always one of ERROR_CODES (libs/errors.ts), so a typo does not compile. */
    code: ErrorCode;
    details?: unknown;
  };
}

export function apiResponse<T>(options: ApiResponse<T>): ApiResponse<T> {
  const { success, message, data, error } = options;

  return {
    success,
    message,
    // `!== undefined`, NOT a truthiness check.
    //
    // `...(data && { data })` drops any falsy payload: a count of `0`, a
    // `false` flag, an empty string. The endpoint looks correct, the client
    // reads `undefined`, and the bug surfaces months later as "the count
    // disappears when it hits zero". `undefined` is the only value that
    // genuinely means "no data".
    ...(data !== undefined && { data }),
    ...(error !== undefined && { error }),
  };
}
