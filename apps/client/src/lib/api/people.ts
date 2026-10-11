/**
 * Tenants and the people inside them. Response types are copied by hand from
 * apps/api/src/modules/tenancy (members.service.ts, invitations.service.ts).
 */

import { api } from './api'

export interface Member {
  user_id: string
  name: string
  email: string
  role: { id: string; name: string }
  /** 'org': sees every tenant through an org role (owner, admin); not managed per tenant. */
  access: 'tenant' | 'org'
  since: string
  /** False when the account is deactivated: listed, but cannot sign in. */
  active: boolean
}

/** A role you may be offered when inviting or changing someone. */
export interface AssignableRole {
  id: string
  /** Built-in roles only ('owner', 'manager', ...). */
  key: string | null
  name: string
  description: string | null
  /** False when the role has a permission you lack: you cannot hand it out. */
  assignable: boolean
}

export interface Invitation {
  id: string
  email: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  role: { id: string; name: string }
  expires_at: string
  accepted_at: string | null
  created_at: string
}

/** One address's outcome in a batch of invitations. */
export interface BulkInviteResult {
  email: string
  /** skipped: already has access, or deactivated (`message` says which). */
  status: 'sent' | 'resent' | 'skipped' | 'invalid' | 'failed'
  message?: string
}

const t = (tenantId: string) => `/t/${encodeURIComponent(tenantId)}` as const

export const peopleApi = {
  members: (tenantId: string) => api.get<Member[]>(`${t(tenantId)}/members`),

  changeRole: (tenantId: string, userId: string, roleId: string) =>
    api.patch<undefined>(
      `${t(tenantId)}/members/${encodeURIComponent(userId)}`,
      { role_id: roleId },
    ),

  remove: (tenantId: string, userId: string) =>
    api.delete<undefined>(
      `${t(tenantId)}/members/${encodeURIComponent(userId)}`,
    ),

  roles: (tenantId: string) =>
    api.get<AssignableRole[]>(`${t(tenantId)}/roles`),

  invitations: (tenantId: string) =>
    api.get<Invitation[]>(`${t(tenantId)}/invitations`),

  /** Inviting the same email again replaces the earlier link (a resend). */
  invite: (tenantId: string, input: { email: string; role_id: string }) =>
    api.post<{ id: string; expires_at: string }>(
      `${t(tenantId)}/invitations`,
      input,
    ),

  /** Many addresses, one role; each is reported on its own. */
  inviteMany: (
    tenantId: string,
    input: { emails: string[]; role_id: string },
  ) =>
    api.post<{ results: BulkInviteResult[] }>(
      `${t(tenantId)}/invitations/bulk`,
      input,
    ),

  revokeInvitation: (tenantId: string, invitationId: string) =>
    api.delete<undefined>(
      `${t(tenantId)}/invitations/${encodeURIComponent(invitationId)}`,
    ),
}
