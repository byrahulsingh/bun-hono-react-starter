/**
 * The one place every API call goes through.
 *
 * Feature files next to this one (health.ts, auth.ts, projects.ts, ...) describe
 * endpoints; they never call `fetch` themselves. That keeps these decisions in
 * a single place:
 *
 * - URLs: every path is prefixed with the base path (`/app/api/...`).
 * - The response envelope: `{ success, message, data, error }` is unwrapped
 *   here, so callers get `data` or a thrown ApiError, never a raw Response.
 * - Errors: network failures, timeouts, non-JSON replies (a proxy's HTML 502
 *   page) and API errors all become one ApiError type with a stable `code`.
 * - 401: an expired access token is refreshed once and the request retried;
 *   a session that has ended signs the user out (see lib/auth/session.ts).
 * - No cookies, ever: `credentials: 'omit'`. Identity travels only in the
 *   Authorization header.
 */

import { apiUrl } from '#/lib/app-config'

/**
 * Mirrors apps/api/src/libs/api-response.ts. Kept in sync by hand on purpose:
 * the client and the API share no code or types, only the HTTP contract.
 */
interface ApiResponse<T> {
  success: boolean
  message: string
  data?: T
  error?: {
    code: string
    details?: unknown
  }
}

/**
 * Codes the API sends in `error.code` — a hand-kept copy of ERROR_CODES in
 * apps/api/src/libs/errors.ts. When a code is added there, add it here.
 */
type ServerErrorCode =
  | 'VALIDATION' // `details` is { field: message }; see fieldErrors()
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'GONE'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'UNAVAILABLE'
  // Auth
  | 'INVALID_CREDENTIALS' // wrong email or password (deliberately one code)
  | 'SESSION_EXPIRED' // the session is over: sign in again
  | 'INVALID_DEVICE_PROOF'
  | 'REFRESH_TOKEN_REUSED'
  | 'LINK_INVALID' // a setup / reset / invitation link that is wrong, used or expired
  | 'SSO_REQUIRED' // a password where the organization requires single sign-on

/** Codes only the client produces: the request never got a usable reply. */
type ClientErrorCode =
  | 'NETWORK' // no response at all: offline, DNS, connection refused
  | 'TIMEOUT'
  | 'BAD_RESPONSE' // a reply that is not our JSON envelope

export type ApiErrorCode = ServerErrorCode | ClientErrorCode

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when no response arrived. */
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly details?: unknown,
    /** From the X-Request-Id header: what a user quotes to support. */
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Per-field messages from a VALIDATION error, for showing next to form inputs:
 * `{ email: 'Invalid email address' }`. Nested fields are dotted
 * (`address.city`); a problem with the input as a whole is under `_`. Empty for
 * any other error.
 */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION') return {}
  const { details } = err
  return typeof details === 'object' && details !== null
    ? (details as Record<string, string>)
    : {}
}

/**
 * Fallback when a reply had no `error.code` — only a proxy or an older API
 * would send one. Mirrors codeForStatus in apps/api/src/libs/errors.ts.
 */
function codeForStatus(status: number): ApiErrorCode {
  const byStatus: Record<number, ServerErrorCode> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    410: 'GONE',
    413: 'PAYLOAD_TOO_LARGE',
    422: 'VALIDATION',
    429: 'RATE_LIMITED',
    503: 'UNAVAILABLE',
  }
  return byStatus[status] ?? (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST')
}

interface ApiHooks {
  /** Headers for authenticated requests (the Authorization header). */
  headers?: () => Record<string, string> | undefined
  /**
   * The access token was refused (401 UNAUTHORIZED: expired or unknown).
   * Resolve `true` after refreshing it to retry the request once; `false` to
   * give up. Concurrent 401s share one call.
   */
  onUnauthorized?: () => Promise<boolean>
  /** The session itself is over (401 SESSION_EXPIRED): sign out, no retry. */
  onSessionEnded?: () => void
}

let hooks: ApiHooks = {}

/** Set once at startup (e.g. by the auth module) to plug in headers and 401 handling. */
export function configureApi(next: ApiHooks) {
  hooks = next
}

let unauthorizedInFlight: Promise<boolean> | null = null

/** Five parallel requests that all get 401 trigger one refresh, not five. */
function handleUnauthorized(): Promise<boolean> {
  if (!hooks.onUnauthorized) return Promise.resolve(false)
  unauthorizedInFlight ??= hooks
    .onUnauthorized()
    .catch(() => false)
    .finally(() => {
      unauthorizedInFlight = null
    })
  return unauthorizedInFlight
}

type Query = Record<string, string | number | boolean | null | undefined>

export interface RequestOptions {
  /**
   * `false` for the public auth endpoints (login, refresh, setup, links): no
   * Authorization header, and a 401 is just an error — never a refresh, which
   * would loop or hide a wrong password. Default `true`.
   */
  auth?: boolean
  query?: Query
  body?: unknown
  headers?: Record<string, string>
  /** Cancel from the caller, e.g. when a component unmounts. */
  signal?: AbortSignal
  /** Milliseconds. Default 30 s. */
  timeout?: number
}

const DEFAULT_TIMEOUT = 30_000

function buildUrl(path: `/${string}`, query?: Query): string {
  const url = apiUrl(path)
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

async function request<T>(
  method: string,
  path: `/${string}`,
  options: RequestOptions = {},
  isRetry = false,
): Promise<T> {
  const {
    auth = true,
    query,
    body,
    headers,
    signal,
    timeout = DEFAULT_TIMEOUT,
  } = options
  const isForm = body instanceof FormData

  const timeoutSignal = AbortSignal.timeout(timeout)
  let res: Response
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      // We use no cookies, so never send or accept any.
      credentials: 'omit',
      // Answers carry tokens and personal data: never from or into a cache.
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        // FormData (file uploads) sets its own multipart boundary header.
        ...(body !== undefined &&
          !isForm && { 'Content-Type': 'application/json' }),
        ...(auth && hooks.headers?.()),
        ...headers,
      },
      body:
        body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    })
  } catch (err) {
    // The caller's own cancel is not an error to report; let it through as-is.
    if (signal?.aborted) throw err
    if (timeoutSignal.aborted) {
      throw new ApiError(
        'The server took too long to respond. Try again.',
        0,
        'TIMEOUT',
      )
    }
    throw new ApiError(
      "Couldn't reach the server. Check your connection and try again.",
      0,
      'NETWORK',
    )
  }

  const requestId = res.headers.get('X-Request-Id') ?? undefined

  if (res.status === 204) return undefined as T

  let envelope: ApiResponse<T>
  try {
    envelope = (await res.json()) as ApiResponse<T>
  } catch {
    throw new ApiError(
      `Unexpected response from the server (HTTP ${res.status}).`,
      res.status,
      'BAD_RESPONSE',
      undefined,
      requestId,
    )
  }

  if (!res.ok || !envelope.success) {
    const code =
      (envelope.error?.code as ServerErrorCode | undefined) ??
      codeForStatus(res.status)

    if (auth && res.status === 401) {
      if (code === 'UNAUTHORIZED' && !isRetry && (await handleUnauthorized())) {
        return request<T>(method, path, options, true)
      }
      if (code === 'SESSION_EXPIRED') hooks.onSessionEnded?.()
    }

    throw new ApiError(
      envelope.message || `Request failed (HTTP ${res.status}).`,
      res.status,
      code,
      envelope.error?.details,
      requestId,
    )
  }

  return envelope.data as T
}

export const api = {
  get: <T>(path: `/${string}`, options?: Omit<RequestOptions, 'body'>) =>
    request<T>('GET', path, options),
  post: <T>(path: `/${string}`, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
  put: <T>(path: `/${string}`, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, body }),
  patch: <T>(path: `/${string}`, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, body }),
  delete: <T>(path: `/${string}`, options?: RequestOptions) =>
    request<T>('DELETE', path, options),
}
