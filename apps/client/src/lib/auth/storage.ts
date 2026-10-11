/**
 * The only auth data that survives a reload: the refresh token and the device
 * key, in IndexedDB, plus the browser id and a single sign-on trip under way. The access token never comes here;
 * it lives in memory.
 *
 * One database per install: the name includes the base path, so two installs
 * on the same origin (e.g. /app and /app-staging) never share a session.
 * Note that IndexedDB is per origin, not per path — another app on the same
 * origin could read it, which is why installs should use their own subdomain.
 */

import { createStore, del, get, set } from 'idb-keyval'

import type { DevicePublicKey } from '#/lib/api/auth'

import { basePath } from '#/lib/app-config'

export interface StoredSession {
  refreshToken: string
  /** Non-extractable: IndexedDB keeps the key object itself, never its bytes. */
  privateKey: CryptoKey
}

const store = createStore(`auth${basePath || '/'}`, 'session')
const KEY = 'current'

export async function loadSession(): Promise<StoredSession | null> {
  try {
    const value = await get<StoredSession>(KEY, store)
    return value?.refreshToken && value.privateKey instanceof CryptoKey
      ? value
      : null
  } catch {
    // Private browsing modes or a blocked database: behave as signed out.
    return null
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await set(KEY, session, store)
}

export async function clearSession(): Promise<void> {
  try {
    await del(KEY, store)
  } catch {
    // Nothing stored, or storage unavailable: nothing to clear.
  }
}

const BROWSER_ID = 'browser-id'

/**
 * A random id for this browser that survives sign-out (the device key does
 * not: it is new at every sign-in). Sent when signing in so the server can
 * tell a browser it has seen before from a new one, and email about the new.
 * Null when storage is unavailable: the sign-in then counts as a new browser.
 */
export async function browserId(): Promise<string | null> {
  try {
    const existing = await get<string>(BROWSER_ID, store)
    if (existing) return existing
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const id = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    await set(BROWSER_ID, id, store)
    return id
  } catch {
    return null
  }
}

const PENDING_SSO = 'sso-pending'

/**
 * A trip to the single sign-on provider. The page unloads on the way there,
 * so what must come back with the code waits here: the state to compare,
 * and (signing in) the new device key, whose private half never leaves.
 */
export type PendingSso =
  | {
      purpose: 'sign_in'
      state: string
      expiresAt: number
      privateKey: CryptoKey
      publicJwk: DevicePublicKey
      browserId: string | null
      /** A page inside the app to open once signed in. */
      redirect: string
    }
  | {
      purpose: 'test'
      state: string
      expiresAt: number
      /** The settings page to go back to with the result. */
      returnTo: string
    }

export async function savePendingSso(pending: PendingSso): Promise<void> {
  await set(PENDING_SSO, pending, store)
}

/** The waiting trip, removed as it is read: a callback is used once. Null when none, or too old. */
export async function takePendingSso(): Promise<PendingSso | null> {
  try {
    const pending = await get<PendingSso>(PENDING_SSO, store)
    await del(PENDING_SSO, store)
    return pending && pending.expiresAt > Date.now() ? pending : null
  } catch {
    return null
  }
}
