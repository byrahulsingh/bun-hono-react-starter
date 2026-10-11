/**
 * Preferences that survive a reload, in IndexedDB like the session (one
 * storage API for the whole app; no localStorage, no cookies).
 *
 * IndexedDB is asynchronous, but rendering needs answers immediately (a
 * pinned sidebar must not first draw collapsed and then jump). So they are
 * loaded once at start-up, while the router is waiting for auth anyway, and
 * then read from memory; writes go back to IndexedDB in the background.
 *
 *   device   about this browser, kept after sign-out   (sidebar pinned)
 *   person   about whoever is signed in, wiped when they sign out, so the
 *            next person on a shared computer inherits nothing (last tenant)
 *
 * Its own database, not the auth one: the session code stays untouched, and
 * idb-keyval cannot add a second store to an existing database anyway.
 * Named per base path, like the session, so two installs never mix.
 *
 * Everything here is a convenience: if storage is blocked or slow, the app
 * runs on the defaults.
 */

import { createStore, del, get, set } from 'idb-keyval'
import { create } from 'zustand'

import { basePath } from '#/lib/app-config'
import { useAuthStore } from '#/lib/auth/store'

interface DevicePrefs {
  sidebarPinned: boolean
}

interface PersonPrefs {
  /** The tenant `/` returns to. Re-checked against /me before use. */
  lastTenant: string | null
}

const DEVICE_DEFAULTS: DevicePrefs = { sidebarPinned: false }
const PERSON_DEFAULTS: PersonPrefs = { lastTenant: null }

/** Start-up never waits longer than this for preferences. */
const LOAD_TIMEOUT_MS = 500

const store = createStore(`prefs${basePath || '/'}`, 'prefs')

interface PrefsState {
  device: DevicePrefs
  person: PersonPrefs
}

export const usePrefs = create<PrefsState>()(() => ({
  device: DEVICE_DEFAULTS,
  person: PERSON_DEFAULTS,
}))

function save(key: 'device' | 'person', value: DevicePrefs | PersonPrefs) {
  set(key, value, store).catch(() => {
    // Storage blocked or full: it just won't be remembered.
  })
}

// ─── Loading ─────────────────────────────────────────────────────

let loaded: Promise<void> | null = null

/** Reads the stored preferences into memory, once. Never throws. */
export function loadPrefs(): Promise<void> {
  loaded ??= (async () => {
    const read = Promise.all([
      get<Partial<DevicePrefs>>('device', store),
      get<Partial<PersonPrefs>>('person', store),
    ])
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), LOAD_TIMEOUT_MS),
    )
    try {
      const result = await Promise.race([read, timeout])
      if (!result) return
      const [device, person] = result
      usePrefs.setState({
        device: { ...DEVICE_DEFAULTS, ...device },
        // Someone already signed out while this was loading: theirs is gone.
        person:
          useAuthStore.getState().status === 'signed-out'
            ? PERSON_DEFAULTS
            : { ...PERSON_DEFAULTS, ...person },
      })
    } catch {
      // Blocked database (some private modes): defaults it is.
    }
  })()
  return loaded
}

// ─── Per person: wiped on every sign-out ─────────────────────────
//
// Follows the auth store instead of being called from the sign-out code, so
// auth stays unaware of preferences. Covers every way a session ends: the
// person signing out, expiry, or another tab signing out.

useAuthStore.subscribe((state, previous) => {
  if (state.status === 'signed-out' && previous.status !== 'signed-out') {
    usePrefs.setState({ person: PERSON_DEFAULTS })
    del('person', store).catch(() => {})
  }
})

// ─── Setters ─────────────────────────────────────────────────────

export function setSidebarPinned(sidebarPinned: boolean) {
  const device = { ...usePrefs.getState().device, sidebarPinned }
  usePrefs.setState({ device })
  save('device', device)
}

export function rememberTenant(tenantId: string) {
  if (usePrefs.getState().person.lastTenant === tenantId) return
  const person = { ...usePrefs.getState().person, lastTenant: tenantId }
  usePrefs.setState({ person })
  save('person', person)
}
