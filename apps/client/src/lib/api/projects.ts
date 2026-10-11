/**
 * The example module's API. Response types are copied by hand from
 * apps/api/src/modules/projects (projects.service.ts, projects.catalog.ts).
 */

import { api } from './api'

export type ProjectStatus = 'active' | 'on_hold' | 'done'

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: 'Active',
  on_hold: 'On hold',
  done: 'Done',
}

export interface Project {
  id: string
  name: string
  description: string
  status: ProjectStatus
  /** Null when that person's profile is gone. */
  created_by: { id: string; name: string } | null
  created_at: string
  updated_at: string
}

const base = (tenantId: string) =>
  `/t/${encodeURIComponent(tenantId)}/projects` as const

export const projectsApi = {
  list: (tenantId: string) => api.get<Project[]>(base(tenantId)),

  create: (tenantId: string, input: { name: string; description: string }) =>
    api.post<{ id: string; name: string }>(base(tenantId), input),

  /** Only the fields sent are changed. */
  update: (
    tenantId: string,
    id: string,
    input: Partial<Pick<Project, 'name' | 'description' | 'status'>>,
  ) =>
    api.patch<undefined>(`${base(tenantId)}/${encodeURIComponent(id)}`, input),

  remove: (tenantId: string, id: string) =>
    api.delete<undefined>(`${base(tenantId)}/${encodeURIComponent(id)}`),
}
