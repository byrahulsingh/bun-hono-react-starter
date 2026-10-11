import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { pageNeeds } from '#/components/app/page-guard'
import { PageHeader } from '#/components/people/people-parts'
import { RoleEditor } from '#/components/roles/role-editor'
import type { RoleDraft } from '#/components/roles/role-editor'
import { toast } from '#/components/ui/toast'
import { rolesApi } from '#/lib/api/roles'

/** A new role, or a copy of one (`?from=<role id>`), e.g. to change a built-in. */
export const Route = createFileRoute('/_app/t/$tenantId/org/roles/new')({
  ...pageNeeds('org.roles.manage', 'New role', 'organization'),
  validateSearch: (search: Record<string, unknown>): { from?: string } => ({
    from: typeof search.from === 'string' ? search.from : undefined,
  }),
  loaderDeps: ({ search }) => ({ from: search.from }),
  loader: async ({ deps }) => {
    const data = await rolesApi.list()
    const source = data.roles.find((r) => r.id === deps.from)
    const held = new Set(data.held)
    // A copy keeps only what you may give: duplicating Owner as an admin
    // leaves out billing.
    const permissions = (source?.permissions ?? []).filter((k) => held.has(k))
    const initial: RoleDraft = {
      name: source ? `Copy of ${source.name}` : '',
      description: source?.description ?? '',
      scope: source?.scope ?? 'tenant',
      permissions,
    }
    const leftOut = (source?.permissions.length ?? 0) - permissions.length
    return { ...data, initial, sourceName: source?.name, leftOut }
  },
  component: NewRolePage,
})

function NewRolePage() {
  const { catalog, held, initial, sourceName, leftOut } = Route.useLoaderData()
  const { tenant } = Route.useRouteContext()
  const navigate = useNavigate()
  const back = () =>
    navigate({ to: '/t/$tenantId/org/roles', params: { tenantId: tenant.id } })

  return (
    <div className="flex flex-1 flex-col">
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <PageHeader
          title={sourceName ? `Duplicate ${sourceName}` : 'New role'}
          description="Pick what the role may do. You can change it later; people with the role get the change right away."
        />
      </div>
      <RoleEditor
        mode="create"
        initial={initial}
        catalog={catalog}
        held={new Set(held)}
        notice={
          leftOut > 0
            ? `${leftOut} ${leftOut === 1 ? 'permission was' : 'permissions were'} left out of the copy because you don't have ${leftOut === 1 ? 'it' : 'them'} yourself.`
            : undefined
        }
        submitLabel="Create role"
        onSubmit={async (draft) => {
          await rolesApi.create(draft)
          toast.add({ title: `${draft.name} created`, type: 'success' })
          await back()
        }}
        onCancel={() => void back()}
      />
    </div>
  )
}
