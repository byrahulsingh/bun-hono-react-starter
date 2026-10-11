/**
 * Organization settings: general, branding, email health, single sign-on
 * and the getting-started checklist. Response types are copied by hand from
 * apps/api/src/modules/settings and modules/branding.
 */

import { api } from './api'

export interface BrandAsset {
  id: string
  content_type: string
}

/** What the sign-in page, the app and emails show. Public: no secrets. */
export interface Branding {
  product_name: string
  /** `#rrggbb`, or null for the built-in look. */
  accent_color: string | null
  logo: BrandAsset | null
  icon: BrandAsset | null
  /** Changes on every save. */
  version: string
}

export type AssetSlot = 'logo' | 'icon'

export interface EmailProblem {
  id: string
  recipient: string | null
  subject: string | null
  attempts: number
  last_error: string | null
  created_at: string
  /** Given up at (failed), or the next try (delayed). */
  at: string | null
}

export interface EmailSettings {
  config: {
    /**
     * environment: SMTP_* in the server's .env (wins; read-only here).
     * dashboard: saved here by an owner. development: nothing set, so the
     * local Mailpit. none: production with nothing set; emails can't go out.
     */
    source: EmailSource
    host: string | null
    port: number | null
    secure: boolean
    user: string | null
    password_set: boolean
    from: string | null
  }
  /** Only owners can change the mail server. */
  you_are_owner: boolean
  /** Last successful test email. */
  checked_at: string | null
  last_sent_at: string | null
  failed: EmailProblem[]
  delayed: EmailProblem[]
}

export type EmailSource = 'environment' | 'dashboard' | 'development' | 'none'

/** The mail server as typed in Settings → Email. */
export interface EmailServerInput {
  host: string
  port: number
  /** tls: TLS from the first byte (usually 465). starttls: upgraded after connecting (usually 587). */
  security: 'tls' | 'starttls'
  user?: string
  /** Empty when editing: the saved one is kept. */
  password?: string
  from: string
}

export interface EmailStatus {
  /** Failed since email last worked. */
  failing: number
  /** Retrying after repeated failures. */
  delayed: number
}

export type TwoFactorPolicy = 'off' | 'org_roles' | 'everyone'

export interface SecuritySettings {
  two_factor_policy: TwoFactorPolicy
  /** Required before any rule can be switched on. */
  you_have_two_factor: boolean
  /** Active people who would be asked to set it up, per rule. */
  without_two_factor: { org_roles: number; everyone: number }
}

export type OnboardingStepKey = 'branding' | 'email' | 'team' | 'tenant'

export interface Onboarding {
  dismissed: boolean
  complete: boolean
  steps: { key: OnboardingStepKey; done: boolean; optional: boolean }[]
}

/** Before sign-in too: no token, and never slower than `timeout`. */
export const brandingApi = {
  get: (timeout?: number) =>
    api.get<Branding>('/branding', { auth: false, timeout }),
}

/** One single sign-on connection. The client secret is never sent back. */
export interface SsoConnection {
  id: string
  name: string
  issuer: string
  client_id: string
  domains: string[]
  /** Password sign-in refused for these domains (owners excepted). */
  required: boolean
  /** Last successful test sign-in; null after the provider settings change. */
  tested_at: string | null
  created_at: string
  updated_at: string
}

export interface SsoSettings {
  /** What to register at the provider as the redirect URL. */
  redirect_uri: string
  connections: SsoConnection[]
  /** Only owners can change single sign-on. */
  you_are_owner: boolean
}

export interface SsoConnectionInput {
  name: string
  issuer: string
  client_id: string
  /** Required when adding; left out when editing keeps the stored one. */
  client_secret?: string
  domains: string[]
}

export interface SsoTestResult {
  connection_id: string
  connection_name: string
  ok: boolean
  problem: string | null
  claims: {
    sub: string
    email: string | null
    email_verified: boolean | null
    name: string | null
  } | null
}

export const settingsApi = {
  general: () =>
    api.get<{ name: string; created_at: string }>('/settings/general'),
  rename: (name: string) => api.patch<undefined>('/settings/general', { name }),

  branding: () => api.get<Branding>('/settings/branding'),
  saveBranding: (input: {
    product_name?: string | null
    accent_color?: string | null
  }) => api.patch<Branding>('/settings/branding', input),
  uploadAsset: (slot: AssetSlot, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.put<Branding>(`/settings/branding/${slot}`, form)
  },
  removeAsset: (slot: AssetSlot) =>
    api.delete<Branding>(`/settings/branding/${slot}`),

  email: () => api.get<EmailSettings>('/settings/email'),
  emailStatus: () => api.get<EmailStatus>('/settings/email/status'),
  testEmail: () => api.post<{ sent_to: string }>('/settings/email/test'),
  /** Connects and signs in with these settings, without saving them. */
  testEmailServer: (input: EmailServerInput) =>
    api.post<undefined>('/settings/email/server/test', input),
  /** Checked the same way first; refused if it can't connect. */
  saveEmailServer: (input: EmailServerInput) =>
    api.put<undefined>('/settings/email/server', input),
  removeEmailServer: () => api.delete<undefined>('/settings/email/server'),

  security: () => api.get<SecuritySettings>('/settings/security'),
  saveSecurity: (two_factor_policy: TwoFactorPolicy) =>
    api.patch<undefined>('/settings/security', { two_factor_policy }),

  sso: () => api.get<SsoSettings>('/settings/sso'),
  addSso: (input: SsoConnectionInput) =>
    api.post<SsoConnection>('/settings/sso', input),
  saveSso: (id: string, input: SsoConnectionInput) =>
    api.put<SsoConnection>(`/settings/sso/${encodeURIComponent(id)}`, input),
  removeSso: (id: string) =>
    api.delete<undefined>(`/settings/sso/${encodeURIComponent(id)}`),
  setSsoRequired: (id: string, required: boolean) =>
    api.put<{ signed_out: number }>(
      `/settings/sso/${encodeURIComponent(id)}/required`,
      { required },
    ),
  /** Where to send the browser for a test sign-in. */
  startSsoTest: (id: string) =>
    api.post<{ url: string; state: string }>(
      `/settings/sso/${encodeURIComponent(id)}/test`,
    ),
  finishSsoTest: (input: { state: string; code: string }) =>
    api.post<SsoTestResult>('/settings/sso/test/finish', input),

  onboarding: () => api.get<Onboarding>('/settings/onboarding'),
  dismissOnboarding: () => api.post<undefined>('/settings/onboarding/dismiss'),
}
