/**
 * What the UI may know about auth. Deliberately no tokens here: the access
 * token stays private to session.ts, so nothing can render or log it.
 */

import { create } from 'zustand'

import type { Me } from '#/lib/api/auth'

export type AuthStatus =
  /** Checking the stored session at start-up. */
  | 'loading'
  | 'signed-in'
  | 'signed-out'
  /** A stored session exists but the server could not be reached. */
  | 'unavailable'
  /** No WebCrypto: the page is not on https (or localhost). */
  | 'unsupported'

interface AuthState {
  status: AuthStatus
  me: Me | null
  /** Why the status is `unavailable`, for the retry screen. */
  problem: string | null
  /**
   * How the last sign-out happened: `user` chose it (here or in another tab),
   * `session` means it ended on its own (expired, revoked). Decides whether
   * the login page offers to return to the previous page.
   */
  signedOutBy: 'user' | 'session' | null
}

export const useAuthStore = create<AuthState>(() => ({
  status: 'loading',
  me: null,
  problem: null,
  signedOutBy: null,
}))

/** Signed-in user's data; only call where the route guard guarantees sign-in. */
export function useMe() {
  const me = useAuthStore((s) => s.me)
  if (!me) throw new Error('useMe() used outside a signed-in route')
  return me
}
