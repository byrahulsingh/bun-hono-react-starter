import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'

import { pageNeeds } from '#/components/app/page-guard'
import { PageHeader } from '#/components/people/people-parts'
import { RoleEditor } from '#/components/roles/role-editor'
import { Badge } from '#/components/ui/badge'
import { toast } from '#/components/ui/toast'
import { rolesApi } from '#/lib/api/roles'

export const Route = createFileRoute('/_app/t/$tenantId/org/roles/$roleId')({
  ...pageNeeds('org.roles.manage', 'Role', 'organization'),
  loader: async ({ params }) => {
    const data = await rolesApi.list()
    const role = data.roles.find((r) => r.id === params.roleId)
    if (!role) throw notFound()
    return { ...data, role }
  },
  notFoundComponent: () => (
    <div className="p-6 text-sm text-muted-foreground">
      This role does not exist or was deleted.
    </div>
  ),
  component: RolePage,
})

function RolePage() {
  const { role, catalog, held } = Route.useLoaderData()
  const { tenant } = Route.useRouteContext()
  const navigate = useNavigate()
  const heldSet = new Set(held)
  const aboveYou = role.permissions.some((k) => !heldSet.has(k))
  const readOnly = role.is_system || aboveYou
  const back = () =>
    navigate({ to: '/t/$tenantId/org/roles', params: { tenantId: tenant.id } })

  return (
    <div className="flex flex-1 flex-col">
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <PageHeader
          title={role.name}
          description={
            role.scope === 'org'
              ? 'Organization role: applies in every tenant.'
              : 'Tenant role: applies in the tenant it is given in.'
          }
          action={role.is_system && <Badge variant="outline">Built-in</Badge>}
        />
      </div>
      <RoleEditor
        // A fresh editor when moving between roles.
        key={role.id}
        mode={readOnly ? 'view' : 'edit'}
        initial={{
          name: role.name,
          description: role.description ?? '',
          scope: role.scope,
          permissions: role.permissions,
        }}
        catalog={catalog}
        held={heldSet}
        usage={role.usage}
        notice={
          role.is_system
            ? 'Built-in roles are locked so they always mean the same thing. Duplicate it from the Roles list to make your own version.'
            : aboveYou
              ? "This role has permissions you don't have, so you can't change it."
              : undefined
        }
        submitLabel="Save role"
        onSubmit={async (draft) => {
          await rolesApi.update(role.id, draft)
          toast.add({ title: `${draft.name} saved`, type: 'success' })
          await back()
        }}
        onCancel={() => void back()}
      />
    </div>
  )
}
