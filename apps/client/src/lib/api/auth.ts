/**
 * Auth, setup, invitation and permission endpoints. Response types are copied
 * by hand from the API (apps/api/src/modules/iam, modules/tenancy): the two
 * apps share no code, only the HTTP contract.
 *
 * Calls that happen before anyone is signed in pass `auth: false`, so they
 * never carry a token and a 401 from them is a plain error.
 */

import { api } from './api'

/** The public half of the device key, as a JWK. */
export interface DevicePublicKey {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

export interface TokenPair {
  access_token: string
  token_type: 'Bearer'
  /** Seconds until the access token expires. */
  expires_in: number
  refresh_token: string
}

export interface Me {
  user: { id: string; email: string; name: string }
  /** owner / admin, or null when access comes only from tenant memberships. */
  org_role: { id: string; key: string | null; name: string } | null
  org_permissions: string[]
  /** Main tenant first, then by name. role is null when access comes from the org role. */
  tenants: {
    id: string
    name: string
    /** The organization's own tenant (made at setup); the others are clients or teams. */
    is_main: boolean
    role: { id: string; name: string } | null
  }[]
}

/**
 * A sign-in that needs one more step: a code (two-factor is on), or setting
 * two-factor up (the organization requires it). The challenge goes back with
 * the code, from the same device.
 */
export interface TwoFactorPending {
  two_factor: {
    step: 'verify' | 'setup'
    challenge: string
    expires_in: number
  }
}

/** What signing in answers: tokens, or the step still needed. */
export type SignInResult = TokenPair | TwoFactorPending

/** The current person's two-factor sign-in (Account page). */
export interface TwoFactorStatus {
  enabled: boolean
  enabled_at: string | null
  recovery_codes_left: number
  /** The organization requires it for them: it cannot be turned off. */
  required: boolean
}

/** A new sign-in to the account, as its email link describes it. */
export interface SignInAlertPreview {
  user_agent: string | null
  ip: string | null
  signed_in_at: string
  /** False when that session has already ended. */
  session_active: boolean
}

/** A new sign-in email waiting for its confirmation link. */
export interface PendingEmailChange {
  new_email: string
  expires_at: string
}

export interface InvitationPreview {
  email: string
  organization_name: string
  tenant_name: string | null
  role_name: string
  inviter_name: string | null
  expires_at: string
  account_exists: boolean
  /** Single sign-on for the invited email's domain: offered, or (required) the only way in. */
  sso: { name: string; required: boolean } | null
}

/** Where to send the browser to sign in with single sign-on. */
export interface SsoStart {
  url: string
  /** Comes back from the provider; checked against this before finishing. */
  state: string
  connection_name: string
  expires_in: number
}

const PUBLIC = { auth: false } as const

export const authApi = {
  login: (input: {
    email: string
    password: string
    device_public_key: DevicePublicKey
    browser_id?: string
  }) => api.post<SignInResult>('/auth/login', input, PUBLIC),

  /** The second step: a code from the app, or a recovery code. */
  verifyTwoFactor: (input: {
    challenge: string
    code: string
    device_public_key: DevicePublicKey
    browser_id?: string
  }) => api.post<TokenPair>('/auth/login/two-factor', input, PUBLIC),

  /** Required but not set up: a secret for the authenticator app. */
  startTwoFactorSetup: (input: {
    challenge: string
    device_public_key: DevicePublicKey
  }) =>
    api.post<{ secret: string }>('/auth/login/two-factor/setup', input, PUBLIC),

  finishTwoFactorSetup: (input: {
    challenge: string
    code: string
    device_public_key: DevicePublicKey
    browser_id?: string
  }) =>
    api.post<TokenPair & { recovery_codes: string[] }>(
      '/auth/login/two-factor/setup/confirm',
      input,
      PUBLIC,
    ),

  refresh: (input: { refresh_token: string; proof: string }) =>
    api.post<TokenPair>('/auth/refresh', input, PUBLIC),

  logout: (scope: 'local' | 'others' | 'global') =>
    api.post<undefined>('/auth/logout', { scope }),

  me: () => api.get<Me>('/me'),

  changePassword: (input: { current_password: string; new_password: string }) =>
    api.post<undefined>('/auth/change-password', input),

  /** Whether to offer "Sign in with SSO" at all. */
  ssoAvailable: () => api.get<{ available: boolean }>('/auth/sso', PUBLIC),

  ssoStart: (input: {
    email: string
    device_public_key: DevicePublicKey
    browser_id?: string
  }) => api.post<SsoStart>('/auth/sso/start', input, PUBLIC),

  /** Back from the provider, from the same device. */
  ssoFinish: (input: {
    state: string
    code: string
    device_public_key: DevicePublicKey
    browser_id?: string
  }) => api.post<TokenPair>('/auth/sso/finish', input, PUBLIC),

  /** The link from a new-sign-in email: what it is about. */
  previewSignInAlert: (token: string) =>
    api.post<SignInAlertPreview>(
      '/auth/sign-in-alert/preview',
      { token },
      PUBLIC,
    ),

  /** "This wasn't me": signs that session out. */
  reportSignInAlert: (token: string) =>
    api.post<undefined>('/auth/sign-in-alert/report', { token }, PUBLIC),

  /** The link sent to a new email address. */
  confirmEmailChange: (token: string) =>
    api.post<{ email: string }>(
      '/auth/email-change/confirm',
      { token },
      PUBLIC,
    ),

  forgotPassword: (email: string) =>
    api.post<undefined>('/auth/forgot-password', { email }, PUBLIC),

  resetPassword: (input: {
    token: string
    password: string
    device_public_key: DevicePublicKey
    browser_id?: string
  }) => api.post<SignInResult>('/auth/reset-password', input, PUBLIC),
}

/** One signed-in device of the current person. */
export interface SessionSummary {
  id: string
  user_agent: string | null
  ip: string | null
  created_at: string
  /** Last token refresh: roughly when the device was last in use. */
  last_active_at: string
  current: boolean
}

export const accountApi = {
  updateProfile: (input: { name: string }) =>
    api.patch<undefined>('/me', input),

  sessions: () => api.get<SessionSummary[]>('/auth/sessions'),

  /** Another device only; this one signs out with signOut(). */
  endSession: (sessionId: string) =>
    api.delete<undefined>(`/auth/sessions/${encodeURIComponent(sessionId)}`),

  /** Whether there is a password to change, and which SSO connections sign this person in. */
  signInMethods: () =>
    api.get<{ password: boolean; sso: string[] }>('/auth/sign-in-methods'),

  pendingEmailChange: () =>
    api.get<PendingEmailChange | null>('/auth/email-change'),
  /** Emails a confirmation link to the new address; nothing changes until it is opened. */
  changeEmail: (input: {
    new_email: string
    password: string
    code?: string
  }) => api.post<PendingEmailChange>('/auth/email-change', input),
  cancelEmailChange: () => api.delete<undefined>('/auth/email-change'),

  twoFactor: () => api.get<TwoFactorStatus>('/auth/two-factor'),
  /** Step 1 of turning it on: the password again; returns the app's secret. */
  beginTwoFactor: (password: string) =>
    api.post<{ secret: string }>('/auth/two-factor/setup', { password }),
  /** Step 2: the first code. Returns the recovery codes, the only time they are shown. */
  confirmTwoFactor: (code: string) =>
    api.post<{ recovery_codes: string[] }>('/auth/two-factor/confirm', {
      code,
    }),
  disableTwoFactor: (input: { password: string; code: string }) =>
    api.post<undefined>('/auth/two-factor/disable', input),
  newRecoveryCodes: (code: string) =>
    api.post<{ recovery_codes: string[] }>('/auth/two-factor/recovery-codes', {
      code,
    }),
}

export const setupApi = {
  status: () => api.get<{ needs_setup: boolean }>('/setup/status', PUBLIC),

  complete: (input: {
    token: string
    organization_name: string
    name: string
    email: string
    password: string
    device_public_key: DevicePublicKey
    browser_id?: string
  }) => api.post<TokenPair>('/setup', input, PUBLIC),
}

export const invitationApi = {
  preview: (token: string) =>
    api.post<InvitationPreview>('/invitations/preview', { token }, PUBLIC),

  acceptNew: (input: {
    token: string
    name: string
    password: string
    device_public_key: DevicePublicKey
    browser_id?: string
  }) => api.post<SignInResult>('/invitations/accept', input, PUBLIC),

  acceptSignedIn: (token: string) =>
    api.post<undefined>('/invitations/accept-signed-in', { token }),
}

export const tenantApi = {
  /** The caller's permission keys inside one tenant. */
  permissions: (tenantId: string) =>
    api.get<string[]>(`/t/${encodeURIComponent(tenantId)}/permissions`),
}
