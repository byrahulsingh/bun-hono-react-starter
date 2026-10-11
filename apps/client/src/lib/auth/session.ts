/**
 * The browser side of auth.
 *
 *   memory      the access token (10 min). Module-private: not in React state,
 *               not in the store, so no component or devtool can display it.
 *   IndexedDB   the refresh token + the non-extractable device key (storage.ts)
 *   store       only what the UI needs: status and /me (store.ts)
 *
 * Refreshes are serialized across tabs with a Web Lock, and each one saves the
 * rotated token before releasing it, so tabs never race on the same token.
 * Tabs tell each other about sign-in and sign-out over a BroadcastChannel.
 */

import { ApiError, configureApi } from '#/lib/api/api'
import type { ApiErrorCode } from '#/lib/api/api'
import type { DeviceKey } from '#/lib/auth/device'
import type { DevicePublicKey, SignInResult, TokenPair } from '#/lib/api/auth'
import { authApi, invitationApi, setupApi, tenantApi } from '#/lib/api/auth'
import { basePath } from '#/lib/app-config'
import {
  cryptoAvailable,
  generateDeviceKey,
  signRefreshProof,
} from '#/lib/auth/device'
import {
  browserId,
  clearSession,
  loadSession,
  saveSession,
  savePendingSso,
  takePendingSso,
} from '#/lib/auth/storage'
import { settingsApi } from '#/lib/api/settings'
import type { SsoTestResult } from '#/lib/api/settings'
import { useAuthStore } from '#/lib/auth/store'

/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 60_000
const scope = basePath || '/'

let accessToken: string | null = null
let accessExpiresAt = 0
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let refreshInFlight: Promise<void> | null = null
let started: Promise<void> | null = null

const channel =
  'BroadcastChannel' in window ? new BroadcastChannel(`auth:${scope}`) : null

type TabMessage =
  { type: 'signed-in' } | { type: 'signed-out'; by: 'user' | 'session' }

/** The stored session is gone or was refused: the user must sign in again. */
export class SessionEndedError extends Error {
  constructor() {
    super('Your session has ended. Please sign in again.')
    this.name = 'SessionEndedError'
  }
}

/** Answers to a refresh that mean the session is over (versus a network blip). */
const SESSION_OVER: ApiErrorCode[] = [
  'SESSION_EXPIRED',
  'REFRESH_TOKEN_REUSED',
  'INVALID_DEVICE_PROOF',
  'UNAUTHORIZED',
  'VALIDATION',
  'BAD_REQUEST',
]

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  // Web Locks exist in every current browser; without them (very old ones)
  // tabs may race, which the server's one-step-behind tolerance absorbs.
  if ('locks' in navigator)
    return navigator.locks.request(`auth-refresh:${scope}`, fn)
  return fn()
}

function setAccess(pair: TokenPair) {
  accessToken = pair.access_token
  accessExpiresAt = Date.now() + pair.expires_in * 1000
  scheduleRefresh()
}

function scheduleRefresh() {
  clearTimeout(refreshTimer)
  const delay = Math.max(accessExpiresAt - Date.now() - REFRESH_EARLY_MS, 0)
  refreshTimer = setTimeout(() => {
    // Hidden tabs wait: the visibility handler refreshes when they come back.
    if (document.visibilityState === 'visible') void refresh().catch(() => {})
  }, delay)
}

// ─── Refresh ─────────────────────────────────────────────────────

/**
 * Gets a new access token with the stored refresh token and a fresh device
 * proof. One at a time per tab (shared promise) and per browser (Web Lock).
 * Throws SessionEndedError (after signing out) when the session is over; any
 * other error (offline, server down) leaves the stored session untouched.
 */
export function refresh(): Promise<void> {
  refreshInFlight ??= withLock(async () => {
    // Read inside the lock: another tab may have just rotated the token.
    const stored = await loadSession()
    if (!stored) throw new SessionEndedError()

    const proof = await signRefreshProof(stored.privateKey, stored.refreshToken)
    let pair: TokenPair
    try {
      pair = await authApi.refresh({
        refresh_token: stored.refreshToken,
        proof,
      })
    } catch (err) {
      if (err instanceof ApiError && SESSION_OVER.includes(err.code))
        throw new SessionEndedError()
      throw err
    }
    // Saved before the lock is released: the next tab must use the new token.
    await saveSession({
      refreshToken: pair.refresh_token,
      privateKey: stored.privateKey,
    })
    setAccess(pair)
  })
    .catch(async (err: unknown) => {
      if (err instanceof SessionEndedError) await signOutLocally()
      throw err
    })
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

// ─── Start-up ────────────────────────────────────────────────────

async function loadMe() {
  const me = await authApi.me()
  useAuthStore.setState({
    status: 'signed-in',
    me,
    problem: null,
    signedOutBy: null,
  })
}

/** Turns the stored session (if any) into a signed-in state. */
async function restore(): Promise<void> {
  useAuthStore.setState({ status: 'loading', problem: null })
  const stored = await loadSession()
  if (!stored) {
    // Nothing stored: signed out, without a single network call.
    useAuthStore.setState({ status: 'signed-out', me: null })
    return
  }
  try {
    await refresh()
    await loadMe()
  } catch (err) {
    if (err instanceof SessionEndedError) return // already signed out
    // Offline or server down: keep the session, offer a retry.
    useAuthStore.setState({
      status: 'unavailable',
      problem:
        err instanceof ApiError ? err.message : "Couldn't reach the server.",
    })
  }
}

/** Starts auth once; the router waits on it before rendering any route. */
export function startAuth(): Promise<void> {
  started ??= (async () => {
    if (!cryptoAvailable()) {
      useAuthStore.setState({ status: 'unsupported' })
      return
    }

    configureApi({
      headers: () =>
        accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      onUnauthorized: async () => {
        try {
          await refresh()
          return true
        } catch {
          return false
        }
      },
      onSessionEnded: () => void signOutLocally(),
    })

    channel?.addEventListener('message', (event: MessageEvent<TabMessage>) => {
      const { status } = useAuthStore.getState()
      if (event.data.type === 'signed-out' && status !== 'signed-out') {
        // The sending tab already cleared storage. Clearing again here could
        // delete a session it has since created.
        void signOutLocally({
          by: event.data.by,
          notifyTabs: false,
          clearStorage: false,
        })
      }
      if (event.data.type === 'signed-in' && status !== 'signed-in')
        void restore()
    })

    document.addEventListener('visibilitychange', () => {
      const { status } = useAuthStore.getState()
      if (
        document.visibilityState === 'visible' &&
        status === 'signed-in' &&
        accessExpiresAt - Date.now() < REFRESH_EARLY_MS
      ) {
        void refresh().catch(() => {})
      }
    })

    await restore()
  })()
  return started
}

/** For the "Try again" button when the server could not be reached. */
export const retryStart = () => restore()

// ─── Signing in (all four ways end here) ─────────────────────────

async function begin(pair: TokenPair, device: DeviceKey) {
  await withLock(() =>
    saveSession({
      refreshToken: pair.refresh_token,
      privateKey: device.privateKey,
    }),
  )
  setAccess(pair)
  await loadMe()
  channel?.postMessage({ type: 'signed-in' } satisfies TabMessage)
}

/**
 * The second step of a sign-in, when the server asked for one. Only the
 * device that entered the password can finish it (the key stays in memory).
 */
export interface TwoFactorChallenge {
  step: 'verify' | 'setup'
  /** A code from the app, or a recovery code. Signs in. */
  verify: (code: string) => Promise<void>
  /** Setup (required by the organization): the secret for the app. */
  startSetup: () => Promise<string>
  /**
   * Setup: the first code. Returns the recovery codes, to show before
   * `signIn` (which leaves the page) is called.
   */
  finishSetup: (
    code: string,
  ) => Promise<{ recoveryCodes: string[]; signIn: () => Promise<void> }>
}

/** What every sign-in sends about this browser. */
interface DeviceFields {
  device_public_key: DevicePublicKey
  browser_id?: string
}

/**
 * A fresh device key for the new session, and the lasting browser id that
 * tells the server whether this browser is new to the account.
 */
async function newSignIn(): Promise<{
  device: DeviceKey
  fields: DeviceFields
}> {
  const [device, id] = await Promise.all([generateDeviceKey(), browserId()])
  return {
    device,
    fields: {
      device_public_key: device.publicJwk,
      ...(id && { browser_id: id }),
    },
  }
}

/** Signed in (null), or the two-factor step still to do. */
async function afterPassword(
  result: SignInResult,
  { device, fields }: { device: DeviceKey; fields: DeviceFields },
): Promise<TwoFactorChallenge | null> {
  if (!('two_factor' in result)) {
    await begin(result, device)
    return null
  }
  const { step, challenge } = result.two_factor
  return {
    step,
    verify: async (code) => {
      const pair = await authApi.verifyTwoFactor({
        challenge,
        code,
        ...fields,
      })
      await begin(pair, device)
    },
    startSetup: async () =>
      (
        await authApi.startTwoFactorSetup({
          challenge,
          device_public_key: fields.device_public_key,
        })
      ).secret,
    finishSetup: async (code) => {
      const { recovery_codes, ...pair } = await authApi.finishTwoFactorSetup({
        challenge,
        code,
        ...fields,
      })
      return {
        recoveryCodes: recovery_codes,
        signIn: () => begin(pair, device),
      }
    },
  }
}

export async function signIn(email: string, password: string) {
  const next = await newSignIn()
  const result = await authApi.login({ email, password, ...next.fields })
  return afterPassword(result, next)
}

export async function completeSetup(input: {
  token: string
  organization_name: string
  name: string
  email: string
  password: string
}) {
  const { device, fields } = await newSignIn()
  const pair = await setupApi.complete({ ...input, ...fields })
  await begin(pair, device)
}

/** With two-factor on, the new password is set and the code is still asked for. */
export async function resetPassword(token: string, password: string) {
  // A reset ends every session of that account, so drop any local one first.
  if (useAuthStore.getState().status === 'signed-in')
    await signOutLocally({ by: 'user' })
  const next = await newSignIn()
  const result = await authApi.resetPassword({
    token,
    password,
    ...next.fields,
  })
  return afterPassword(result, next)
}

export async function acceptInvitationAsNew(input: {
  token: string
  name: string
  password: string
}) {
  const next = await newSignIn()
  const result = await invitationApi.acceptNew({ ...input, ...next.fields })
  return afterPassword(result, next)
}

// ─── Single sign-on ──────────────────────────────────────────────

/**
 * Leaves for the provider. The device key for the new session is made now
 * and waits in IndexedDB (the page unloads), so the code can only be
 * finished from this browser.
 */
export async function startSso(email: string, redirect = '/'): Promise<never> {
  const { device, fields } = await newSignIn()
  const start = await authApi.ssoStart({ email, ...fields })
  await savePendingSso({
    purpose: 'sign_in',
    state: start.state,
    expiresAt: Date.now() + start.expires_in * 1000,
    privateKey: device.privateKey,
    publicJwk: device.publicJwk,
    browserId: fields.browser_id ?? null,
    redirect,
  })
  window.location.assign(start.url)
  // The page is leaving; nothing after this runs.
  return new Promise<never>(() => {})
}

/** An owner trying a connection out, from Settings. */
export async function startSsoTest(
  connectionId: string,
  returnTo: string,
): Promise<never> {
  const start = await settingsApi.startSsoTest(connectionId)
  await savePendingSso({
    purpose: 'test',
    state: start.state,
    expiresAt: Date.now() + 10 * 60_000,
    returnTo,
  })
  window.location.assign(start.url)
  return new Promise<never>(() => {})
}

export class SsoCallbackError extends Error {}

/**
 * Back from the provider with `code` and `state`. Only finishes the trip this
 * browser started (same state): a link someone else sends, with their code,
 * goes nowhere.
 */
export async function finishSso(
  code: string,
  state: string,
): Promise<
  | { purpose: 'sign_in'; redirect: string }
  | { purpose: 'test'; result: SsoTestResult; returnTo: string }
> {
  const pending = await takePendingSso()
  if (!pending || pending.state !== state) {
    throw new SsoCallbackError(
      'This sign-in was not started here, or took too long. Start again.',
    )
  }
  if (pending.purpose === 'test') {
    const result = await settingsApi.finishSsoTest({ state, code })
    return { purpose: 'test', result, returnTo: pending.returnTo }
  }
  const pair = await authApi.ssoFinish({
    state,
    code,
    device_public_key: pending.publicJwk,
    ...(pending.browserId && { browser_id: pending.browserId }),
  })
  // Someone else signed in on this browser meanwhile: this sign-in replaces theirs.
  if (useAuthStore.getState().status === 'signed-in')
    await signOutLocally({ by: 'user' })
  await begin(pair, {
    privateKey: pending.privateKey,
    publicJwk: pending.publicJwk,
  })
  return { purpose: 'sign_in', redirect: pending.redirect }
}

/** After accepting while signed in: reload /me so the new tenant appears. */
export async function reloadMe() {
  permissionCache.clear()
  await loadMe()
}

// ─── Signing out ─────────────────────────────────────────────────

async function signOutLocally(
  options: {
    by?: 'user' | 'session'
    notifyTabs?: boolean
    clearStorage?: boolean
  } = {},
) {
  const { by = 'session', notifyTabs = true, clearStorage = true } = options
  clearTimeout(refreshTimer)
  accessToken = null
  accessExpiresAt = 0
  permissionCache.clear()
  if (clearStorage) await clearSession()
  useAuthStore.setState({
    status: 'signed-out',
    me: null,
    problem: null,
    signedOutBy: by,
  })
  if (notifyTabs)
    channel?.postMessage({ type: 'signed-out', by } satisfies TabMessage)
}

/** This device (`local`) or every device (`global`). Local sign-out happens even if the server is unreachable. */
export async function signOut(scopeToEnd: 'local' | 'global' = 'local') {
  try {
    if (accessToken) await authApi.logout(scopeToEnd)
  } catch {
    // Best effort: the session still ends here, and expires on the server.
  }
  await signOutLocally({ by: 'user' })
}

/** Ends every other session of this account; this one stays signed in. */
export async function signOutOtherDevices() {
  await authApi.logout('others')
}

// ─── Tenant permissions ──────────────────────────────────────────

const PERMISSIONS_TTL_MS = 30_000
const permissionCache = new Map<string, { keys: Set<string>; until: number }>()

/** The caller's permission keys in a tenant, cached briefly per tab. */
export async function tenantPermissions(
  tenantId: string,
): Promise<Set<string>> {
  const cached = permissionCache.get(tenantId)
  if (cached && cached.until > Date.now()) return cached.keys
  const keys = new Set(await tenantApi.permissions(tenantId))
  permissionCache.set(tenantId, {
    keys,
    until: Date.now() + PERMISSIONS_TTL_MS,
  })
  return keys
}
