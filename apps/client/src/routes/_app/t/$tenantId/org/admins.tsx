import { createFileRoute, useRouter } from '@tanstack/react-router'
import { UserPlusIcon } from 'lucide-react'
import { useState } from 'react'

import { pageNeeds } from '#/components/app/page-guard'
import {
  ChangeRoleDialog,
  ConfirmDialog,
  InviteDialog,
} from '#/components/people/people-dialogs'
import {
  InvitationsTable,
  PageHeader,
  RowActions,
  Section,
  formatDate,
} from '#/components/people/people-parts'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import type { OrgMember } from '#/lib/api/org'
import { orgApi } from '#/lib/api/org'
import type { AssignableRole } from '#/lib/api/people'
import { useMe } from '#/lib/auth/store'

export const Route = createFileRoute('/_app/t/$tenantId/org/admins')({
  ...pageNeeds('org.users.manage', 'Admins', 'organization'),
  loader: async () => {
    const [members, roles, invitations] = await Promise.all([
      orgApi.members(),
      orgApi.roles(),
      orgApi.invitations(),
    ])
    return { members, roles, invitations }
  },
  component: AdminsPage,
})

const tenantsLeft = (n: number) =>
  n === 0
    ? 'They are not a member of any tenant, so they will have no access until invited to one.'
    : `They keep access to the ${n === 1 ? 'tenant' : `${n} tenants`} they are a member of.`

function AdminsPage() {
  const { members, roles, invitations } = Route.useLoaderData()
  const router = useRouter()
  const reload = () => void router.invalidate()

  const [inviting, setInviting] = useState(false)
  const [changing, setChanging] = useState<OrgMember | null>(null)
  const [removing, setRemoving] = useState<OrgMember | null>(null)

  return (
    <div className="flex flex-col gap-8 p-4 md:p-6">
      <PageHeader
        title="Admins"
        description="People with an organization role. They can open every tenant, with that role's permissions."
        action={
          <Button onClick={() => setInviting(true)}>
            <UserPlusIcon aria-hidden="true" />
            Invite admin
          </Button>
        }
      />

      <AdminsTable
        members={members}
        roles={roles}
        onChangeRole={setChanging}
        onRemove={setRemoving}
      />

      <InvitationsTable
        invitations={invitations}
        resend={(inv) =>
          orgApi.invite({ email: inv.email, role_id: inv.role.id })
        }
        revoke={(inv) => orgApi.revokeInvitation(inv.id)}
        onChanged={reload}
      />

      <InviteDialog
        title="Invite an admin"
        roles={roles}
        open={inviting}
        onOpenChange={setInviting}
        invite={orgApi.inviteMany}
        onDone={reload}
      />
      <ChangeRoleDialog
        person={changing}
        roles={roles}
        description="Applies in every tenant, right away."
        onOpenChange={(open) => !open && setChanging(null)}
        change={(roleId) => orgApi.changeRole(changing?.user_id ?? '', roleId)}
        onDone={reload}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? ''}'s organization role?`}
        description={`They lose access to every tenant through it, right away. ${tenantsLeft(removing?.tenant_count ?? 0)}`}
        confirmLabel="Remove role"
        onOpenChange={(open) => !open && setRemoving(null)}
        run={() => orgApi.removeRole(removing?.user_id ?? '')}
        done={`${removing?.name ?? 'Their'} organization role removed`}
        onDone={reload}
      />
    </div>
  )
}

function AdminsTable({
  members,
  roles,
  onChangeRole,
  onRemove,
}: {
  members: OrgMember[]
  roles: AssignableRole[]
  onChangeRole: (member: OrgMember) => void
  onRemove: (member: OrgMember) => void
}) {
  const me = useMe()
  const assignable = new Set(roles.filter((r) => r.assignable).map((r) => r.id))
  // The server decides; this only hides what it would refuse: yourself, and
  // anyone whose role has more than yours (an admin cannot touch an owner).
  const editable = (m: OrgMember) =>
    m.user_id !== me.user.id && assignable.has(m.role.id)

  return (
    <Section
      title="Organization roles"
      description="The organization always keeps at least one owner."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="hidden md:table-cell">Tenants</TableHead>
            <TableHead className="hidden sm:table-cell">Last sign-in</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m) => (
            <TableRow key={m.user_id}>
              <TableCell>
                <div className="font-medium">
                  {m.name}
                  {m.user_id === me.user.id && (
                    <span className="font-normal text-muted-foreground">
                      {' '}
                      (you)
                    </span>
                  )}
                  {!m.active && (
                    <Badge variant="outline" className="ml-2">
                      Deactivated
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{m.email}</div>
              </TableCell>
              <TableCell>
                <Badge
                  variant={m.role.key === 'owner' ? 'default' : 'secondary'}
                >
                  {m.role.name}
                </Badge>
              </TableCell>
              <TableCell className="hidden text-muted-foreground md:table-cell">
                {/* Through the org role they see all; this counts memberships of their own. */}
                All
                {m.tenant_count > 0 && ` · member of ${m.tenant_count}`}
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">
                {m.last_login_at ? formatDate(m.last_login_at) : 'Never'}
              </TableCell>
              <TableCell>
                {editable(m) && (
                  <RowActions
                    label={`Actions for ${m.name}`}
                    actions={[
                      { label: 'Change role', onSelect: () => onChangeRole(m) },
                      {
                        label: 'Remove organization role',
                        onSelect: () => onRemove(m),
                        destructive: true,
                      },
                    ]}
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  )
}
