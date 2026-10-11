import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'

import { pageNeeds } from '#/components/app/page-guard'
import { ConfirmDialog } from '#/components/people/people-dialogs'
import {
  PageHeader,
  RowActions,
  Section,
} from '#/components/people/people-parts'
import { Badge } from '#/components/ui/badge'
import { buttonVariants } from '#/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import type { RoleDetail } from '#/lib/api/roles'
import { rolesApi } from '#/lib/api/roles'

export const Route = createFileRoute('/_app/t/$tenantId/org/roles/')({
  ...pageNeeds('org.roles.manage', 'Roles', 'organization'),
  loader: () => rolesApi.list(),
  component: RolesPage,
})

function usageText({ people, invitations }: RoleDetail['usage']) {
  const parts = [
    people > 0 && `${people} ${people === 1 ? 'person' : 'people'}`,
    invitations > 0 &&
      `${invitations} ${invitations === 1 ? 'invitation' : 'invitations'}`,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'Nobody'
}

const inUse = (role: RoleDetail) =>
  role.usage.people > 0 || role.usage.invitations > 0

function RolesPage() {
  const { roles } = Route.useLoaderData()
  const { tenant } = Route.useRouteContext()
  const router = useRouter()
  const [deleting, setDeleting] = useState<RoleDetail | null>(null)

  return (
    <div className="flex flex-col gap-8 p-4 md:p-6">
      <PageHeader
        title="Roles"
        description="What each role may do. Built-in roles are locked; duplicate one to make your own."
        action={
          <Link
            to="/t/$tenantId/org/roles/new"
            params={{ tenantId: tenant.id }}
            className={buttonVariants()}
          >
            <PlusIcon aria-hidden="true" />
            New role
          </Link>
        }
      />
      <RolesTable
        title="Organization roles"
        description="For admins: apply in every tenant."
        roles={roles.filter((r) => r.scope === 'org')}
        onDelete={setDeleting}
      />
      <RolesTable
        title="Tenant roles"
        description="Given when inviting someone to a tenant: apply in that tenant only. A role still in use cannot be deleted."
        roles={roles.filter((r) => r.scope === 'tenant')}
        onDelete={setDeleting}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? ''}?`}
        description="Nobody has this role, so nothing else changes. The audit log keeps its history."
        confirmLabel="Delete role"
        onOpenChange={(open) => !open && setDeleting(null)}
        run={() => rolesApi.remove(deleting?.id ?? '')}
        done={`${deleting?.name ?? 'Role'} deleted`}
        onDone={() => void router.invalidate()}
      />
    </div>
  )
}

function RolesTable({
  title,
  description,
  roles,
  onDelete,
}: {
  title: string
  description: string
  roles: RoleDetail[]
  onDelete: (role: RoleDetail) => void
}) {
  const navigate = useNavigate()
  const { tenant } = Route.useRouteContext()
  const open = (role: RoleDetail) =>
    void navigate({
      to: '/t/$tenantId/org/roles/$roleId',
      params: { tenantId: tenant.id, roleId: role.id },
    })
  const duplicate = (role: RoleDetail) =>
    void navigate({
      to: '/t/$tenantId/org/roles/new',
      params: { tenantId: tenant.id },
      search: { from: role.id },
    })

  return (
    <Section title={title} description={description}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Role</TableHead>
            <TableHead className="hidden sm:table-cell">Permissions</TableHead>
            <TableHead>Used by</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {roles.map((role) => (
            <TableRow key={role.id}>
              <TableCell className="whitespace-normal">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to="/t/$tenantId/org/roles/$roleId"
                    params={{ tenantId: tenant.id, roleId: role.id }}
                    className="font-medium hover:underline"
                  >
                    {role.name}
                  </Link>
                  {role.is_system && <Badge variant="outline">Built-in</Badge>}
                </div>
                {role.description && (
                  <div className="text-xs text-muted-foreground">
                    {role.description}
                  </div>
                )}
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">
                {role.permissions.length}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {usageText(role.usage)}
              </TableCell>
              <TableCell>
                <RowActions
                  label={`Actions for ${role.name}`}
                  actions={[
                    {
                      label: role.is_system ? 'View' : 'Edit',
                      onSelect: () => open(role),
                    },
                    { label: 'Duplicate', onSelect: () => duplicate(role) },
                    ...(role.is_system || inUse(role)
                      ? []
                      : [
                          {
                            label: 'Delete',
                            onSelect: () => onDelete(role),
                            destructive: true,
                          },
                        ]),
                  ]}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  )
}
