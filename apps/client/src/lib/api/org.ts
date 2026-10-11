/**
 * Organization-level management: tenants and the people with an org role.
 * Response types are copied by hand from apps/api/src/modules/tenancy
 * (tenants.service.ts, org.service.ts).
 */

import { api } from './api'
import type { AssignableRole, BulkInviteResult, Invitation } from './people'

export interface TenantSummary {
  id: string
  name: string
  status: 'active' | 'archived'
  /** The organization's own tenant: listed first, cannot be archived. */
  is_main: boolean
  /** Tenant members only; owners and admins see every tenant on top. */
  member_count: number
  created_at: string
}

export interface OrgMember {
  user_id: string
  name: string
  email: string
  role: { id: string; key: string | null; name: string }
  /** Tenant memberships they keep if the org role is removed. */
  tenant_count: number
  last_login_at: string | null
  /** False when the account is deactivated. */
  active: boolean
}

/** Everyone with an account here (the People directory). */
export interface OrgPerson {
  user_id: string
  name: string
  email: string
  active: boolean
  last_login_at: string | null
  /** Signs in with an authenticator app code as well. */
  two_factor: boolean
  org_role: { id: string; key: string | null; name: string } | null
  tenants: {
    id: string
    name: string
    archived: boolean
    role: { id: string; name: string }
  }[]
}

const id = (value: string) => encodeURIComponent(value)

export const tenantsApi = {
  list: () => api.get<TenantSummary[]>('/tenants'),
  create: (name: string) =>
    api.post<{ id: string; name: string }>('/tenants', { name }),
  rename: (tenantId: string, name: string) =>
    api.patch<undefined>(`/tenants/${id(tenantId)}`, { name }),
  archive: (tenantId: string) =>
    api.post<undefined>(`/tenants/${id(tenantId)}/archive`),
  restore: (tenantId: string) =>
    api.post<undefined>(`/tenants/${id(tenantId)}/restore`),
}

export const orgApi = {
  members: () => api.get<OrgMember[]>('/org/members'),
  roles: () => api.get<AssignableRole[]>('/org/roles'),
  changeRole: (userId: string, roleId: string) =>
    api.patch<undefined>(`/org/members/${id(userId)}`, { role_id: roleId }),
  removeRole: (userId: string) =>
    api.delete<undefined>(`/org/members/${id(userId)}`),

  invitations: () => api.get<Invitation[]>('/invitations'),
  /** Inviting the same email again replaces the earlier link (a resend). */
  invite: (input: { email: string; role_id: string }) =>
    api.post<{ id: string; expires_at: string }>('/invitations', input),
  inviteMany: (input: { emails: string[]; role_id: string }) =>
    api.post<{ results: BulkInviteResult[] }>('/invitations/bulk', input),
  revokeInvitation: (invitationId: string) =>
    api.delete<undefined>(`/invitations/${id(invitationId)}`),

  /** The directory, plus the active tenants people can be added to. */
  people: () =>
    api.get<{ people: OrgPerson[]; tenants: { id: string; name: string }[] }>(
      '/org/people',
    ),
  deactivate: (userId: string) =>
    api.post<undefined>(`/org/people/${id(userId)}/deactivate`),
  reactivate: (userId: string) =>
    api.post<undefined>(`/org/people/${id(userId)}/reactivate`),
  sendPasswordReset: (userId: string) =>
    api.post<undefined>(`/org/people/${id(userId)}/password-reset`),
  /** Lost phone and recovery codes: two-factor off, signed out everywhere. */
  resetTwoFactor: (userId: string) =>
    api.post<undefined>(`/org/people/${id(userId)}/two-factor/reset`),
  addToTenant: (
    userId: string,
    input: { tenant_id: string; role_id: string },
  ) => api.post<undefined>(`/org/people/${id(userId)}/tenants`, input),
}
