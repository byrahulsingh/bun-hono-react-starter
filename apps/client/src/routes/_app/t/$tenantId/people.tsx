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
import type { AssignableRole, Member } from '#/lib/api/people'
import { peopleApi } from '#/lib/api/people'
import { useMe } from '#/lib/auth/store'

export const Route = createFileRoute('/_app/t/$tenantId/people')({
  ...pageNeeds('tenant.users.view', 'People'),
  loader: async ({ params, context }) => {
    // Roles and invitations are for people who can invite; the API refuses
    // them to everyone else, so don't ask.
    const canManage = context.permissions.has('tenant.users.manage')
    const [members, roles, invitations] = await Promise.all([
      peopleApi.members(params.tenantId),
      canManage ? peopleApi.roles(params.tenantId) : [],
      canManage ? peopleApi.invitations(params.tenantId) : [],
    ])
    return { canManage, members, roles, invitations }
  },
  component: PeoplePage,
})

function PeoplePage() {
  const { canManage, members, roles, invitations } = Route.useLoaderData()
  const { tenant } = Route.useRouteContext()
  const router = useRouter()
  const reload = () => void router.invalidate()

  const [inviting, setInviting] = useState(false)
  const [changing, setChanging] = useState<Member | null>(null)
  const [removing, setRemoving] = useState<Member | null>(null)

  return (
    <div className="flex flex-col gap-8 p-4 md:p-6">
      <PageHeader
        title="People"
        description={`Everyone who can open ${tenant.name}, and what they can do here.`}
        action={
          canManage && (
            <Button onClick={() => setInviting(true)}>
              <UserPlusIcon aria-hidden="true" />
              Invite person
            </Button>
          )
        }
      />

      <MembersTable
        members={members}
        roles={roles}
        canManage={canManage}
        onChangeRole={setChanging}
        onRemove={setRemoving}
      />

      {canManage && (
        <>
          <InvitationsTable
            invitations={invitations}
            resend={(inv) =>
              peopleApi.invite(tenant.id, {
                email: inv.email,
                role_id: inv.role.id,
              })
            }
            revoke={(inv) => peopleApi.revokeInvitation(tenant.id, inv.id)}
            onChanged={reload}
          />
          <InviteDialog
            title={`Invite to ${tenant.name}`}
            roles={roles}
            open={inviting}
            onOpenChange={setInviting}
            invite={(input) => peopleApi.inviteMany(tenant.id, input)}
            onDone={reload}
          />
          <ChangeRoleDialog
            person={changing}
            roles={roles}
            description="The change applies right away."
            onOpenChange={(open) => !open && setChanging(null)}
            change={(roleId) =>
              peopleApi.changeRole(tenant.id, changing?.user_id ?? '', roleId)
            }
            onDone={reload}
          />
          <ConfirmDialog
            open={removing !== null}
            title={`Remove ${removing?.name ?? ''}?`}
            description={`They lose access to ${tenant.name} right away. Their account and access to other tenants stay; you can invite them again later.`}
            confirmLabel="Remove"
            onOpenChange={(open) => !open && setRemoving(null)}
            run={() => peopleApi.remove(tenant.id, removing?.user_id ?? '')}
            done={`${removing?.name ?? 'They'} removed from ${tenant.name}`}
            onDone={reload}
          />
        </>
      )}
    </div>
  )
}

function MembersTable({
  members,
  roles,
  canManage,
  onChangeRole,
  onRemove,
}: {
  members: Member[]
  roles: AssignableRole[]
  canManage: boolean
  onChangeRole: (member: Member) => void
  onRemove: (member: Member) => void
}) {
  const me = useMe()
  const assignable = new Set(roles.filter((r) => r.assignable).map((r) => r.id))
  // The server decides; this only hides buttons that would be refused:
  // yourself, org people (managed at org level), and anyone above you.
  const editable = (m: Member) =>
    canManage &&
    m.access === 'tenant' &&
    m.user_id !== me.user.id &&
    assignable.has(m.role.id)

  return (
    <Section
      title="Members"
      description="Owners and admins see every tenant through their organization role."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="hidden sm:table-cell">Since</TableHead>
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
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={m.access === 'org' ? 'default' : 'secondary'}>
                    {m.role.name}
                  </Badge>
                  {m.access === 'org' && (
                    <span className="text-xs text-muted-foreground">
                      organization
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">
                {formatDate(m.since)}
              </TableCell>
              <TableCell>
                {editable(m) && (
                  <RowActions
                    label={`Actions for ${m.name}`}
                    actions={[
                      { label: 'Change role', onSelect: () => onChangeRole(m) },
                      {
                        label: 'Remove from tenant',
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
