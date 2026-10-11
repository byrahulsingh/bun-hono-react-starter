/**
 * The role editor's endpoints. Types copied by hand from
 * apps/api/src/modules/tenancy/roles.service.ts.
 */

import { api } from './api'

export type RoleScope = 'org' | 'tenant'

export interface RoleDetail {
  id: string
  /** Built-in roles only ('owner', 'manager', ...). */
  key: string | null
  name: string
  description: string | null
  scope: RoleScope
  /** Built-in: locked; duplicate it to change it. */
  is_system: boolean
  permissions: string[]
  usage: { people: number; invitations: number }
}

export interface CatalogPermission {
  key: string
  module_key: string
  scope: RoleScope
  label: string
  /** Ticking this one ticks `requires` too (projects.edit needs projects.view). */
  requires: string | null
}

export interface RoleCatalog {
  modules: { key: string; label: string }[]
  permissions: CatalogPermission[]
}

export interface RolesData {
  roles: RoleDetail[]
  catalog: RoleCatalog
  /** The editor's own permissions: the only boxes they may tick. */
  held: string[]
}

export interface RoleInput {
  name: string
  description: string
  permissions: string[]
}

export const rolesApi = {
  list: () => api.get<RolesData>('/roles'),
  create: (input: RoleInput & { scope: RoleScope }) =>
    api.post<{ id: string }>('/roles', input),
  update: (roleId: string, input: RoleInput) =>
    api.patch<undefined>(`/roles/${encodeURIComponent(roleId)}`, input),
  remove: (roleId: string) =>
    api.delete<undefined>(`/roles/${encodeURIComponent(roleId)}`),
}
