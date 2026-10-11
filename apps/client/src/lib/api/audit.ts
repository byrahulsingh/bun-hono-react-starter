/**
 * The audit log (read-only). Types copied by hand from
 * apps/api/src/modules/tenancy/audit-log.service.ts.
 */

import { api } from './api'

export type AuditCategory =
  'security' | 'people' | 'roles' | 'tenants' | 'account' | 'settings'

export interface AuditEntry {
  id: string
  created_at: string
  /** `domain.verb`, e.g. `tenant.renamed`. */
  action: string
  /** Null: the system itself. */
  actor_user_id: string | null
  /** Null: an organization-level event. */
  tenant_id: string | null
  target_type: string | null
  target_id: string | null
  changes: Record<string, unknown> | null
  request_id: string | null
  ip: string | null
  user_agent: string | null
}

export interface AuditRefs {
  users: Record<string, { name: string; email: string | null } | undefined>
  tenants: Record<string, string | undefined>
  roles: Record<string, string | undefined>
  invitations: Record<string, string | undefined>
}

export interface AuditPage {
  entries: AuditEntry[]
  refs: AuditRefs
  /** Cursor for the next, older page; null on the last one. */
  next: string | null
}

export interface AuditFilters {
  category?: AuditCategory
  tenant?: string
  actor?: string
  /** ISO date-times. */
  from?: string
  to?: string
}

export interface AuditFilterOptions {
  tenants: { id: string; name: string; status: string }[]
  people: { id: string; name: string; email: string | null }[]
}

export const auditApi = {
  page: (filters: AuditFilters, before?: string) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries({ ...filters, before }))
      if (value) params.set(key, value)
    const query = params.toString()
    return api.get<AuditPage>(`/audit${query ? `?${query}` : ''}`)
  },
  filters: () => api.get<AuditFilterOptions>('/audit/filters'),
}
