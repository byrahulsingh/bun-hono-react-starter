import { createFileRoute, useRouter } from '@tanstack/react-router'
import { SearchIcon } from 'lucide-react'
import { useState } from 'react'

import { pageNeeds } from '#/components/app/page-guard'
import { AddToTenantDialog } from '#/components/people/add-to-tenant-dialog'
import { ConfirmDialog } from '#/components/people/people-dialogs'
import {
  PageHeader,
  RowActions,
  Section,
  formatDate,
} from '#/components/people/people-parts'
import { Badge } from '#/components/ui/badge'
import { Input } from '#/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import type { OrgPerson } from '#/lib/api/org'
import { orgApi } from '#/lib/api/org'
import { useMe } from '#/lib/auth/store'

export const Route = createFileRoute('/_app/t/$tenantId/org/people')({
  ...pageNeeds('org.users.manage', 'People directory', 'organization'),
  loader: async () => {
    const [{ people, tenants }, orgRoles] = await Promise.all([
      orgApi.people(),
      orgApi.roles(),
    ])
    return { people, tenants, orgRoles }
  },
  component: DirectoryPage,
})

type Status = 'all' | 'active' | 'deactivated'
const STATUS_LABELS: Record<Status, string> = {
  all: 'Everyone',
  active: 'Active',
  deactivated: 'Deactivated',
}

type Pending = {
  kind: 'deactivate' | 'reactivate' | 'reset' | 'two_factor'
  person: OrgPerson
} | null

function DirectoryPage() {
  const { people, tenants, orgRoles } = Route.useLoaderData()
  const me = useMe()
  const router = useRouter()
  const reload = () => void router.invalidate()

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Status>('all')
  const [adding, setAdding] = useState<OrgPerson | null>(null)
  const [pending, setPending] = useState<Pending>(null)

  const q = query.trim().toLowerCase()
  const shown = people.filter(
    (p) =>
      (status === 'all' || p.active === (status === 'active')) &&
      (!q ||
        p.name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        p.tenants.some((t) => t.name.toLowerCase().includes(q))),
  )

  // The server decides; this only hides what it would refuse: yourself, and
  // anyone whose org role carries more than yours (an admin and an owner).
  const assignable = new Set(
    orgRoles.filter((r) => r.assignable).map((r) => r.id),
  )
  const manageable = (p: OrgPerson) =>
    p.user_id !== me.user.id && (!p.org_role || assignable.has(p.org_role.id))

  const deactivated = people.filter((p) => !p.active).length

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="People directory"
        description="Everyone with an account in the organization, where they have access, and their account status."
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search people"
            placeholder="Search by name, email or tenant"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select
          value={status}
          items={STATUS_LABELS}
          onValueChange={(value) => value && setStatus(value)}
        >
          <SelectTrigger aria-label="Account status" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {(Object.keys(STATUS_LABELS) as Status[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Section
        title={`${people.length} ${people.length === 1 ? 'person' : 'people'}${deactivated ? ` · ${deactivated} deactivated` : ''}`}
        description="Deactivating signs someone out everywhere and blocks sign-in. Their roles and tenants are kept, so reactivating gives back exactly what they had."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Access</TableHead>
              <TableHead className="hidden md:table-cell">
                Last sign-in
              </TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-8 text-center text-muted-foreground"
                >
                  Nobody matches.
                </TableCell>
              </TableRow>
            )}
            {shown.map((p) => (
              <TableRow
                key={p.user_id}
                className={p.active ? '' : 'text-muted-foreground'}
              >
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {p.name}
                    {p.user_id === me.user.id && (
                      <span className="font-normal text-muted-foreground">
                        (you)
                      </span>
                    )}
                    {p.two_factor && (
                      <Badge
                        variant="secondary"
                        className="font-normal"
                        title="Signs in with a code from an authenticator app as well"
                      >
                        2FA
                      </Badge>
                    )}
                    {!p.active && <Badge variant="outline">Deactivated</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">{p.email}</div>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <Access person={p} />
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {p.last_login_at ? formatDate(p.last_login_at) : 'Never'}
                </TableCell>
                <TableCell>
                  {manageable(p) && (
                    <RowActions
                      label={`Actions for ${p.name}`}
                      actions={
                        p.active
                          ? [
                              ...(p.org_role
                                ? []
                                : [
                                    {
                                      label: 'Add to tenant',
                                      onSelect: () => setAdding(p),
                                    },
                                  ]),
                              {
                                label: 'Send password reset link',
                                onSelect: () =>
                                  setPending({ kind: 'reset', person: p }),
                              },
                              ...(p.two_factor
                                ? [
                                    {
                                      label: 'Reset two-factor',
                                      onSelect: () =>
                                        setPending({
                                          kind: 'two_factor',
                                          person: p,
                                        }),
                                    },
                                  ]
                                : []),
                              {
                                label: 'Deactivate account',
                                onSelect: () =>
                                  setPending({ kind: 'deactivate', person: p }),
                                destructive: true,
                              },
                            ]
                          : [
                              {
                                label: 'Reactivate account',
                                onSelect: () =>
                                  setPending({ kind: 'reactivate', person: p }),
                              },
                            ]
                      }
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <AddToTenantDialog
        person={adding}
        tenants={tenants}
        onOpenChange={(open) => !open && setAdding(null)}
        onDone={reload}
      />
      <PendingConfirm
        pending={pending}
        onClose={() => setPending(null)}
        onDone={reload}
      />
    </div>
  )
}

/** Org role (every tenant), or the tenants they are a member of. */
function Access({ person }: { person: OrgPerson }) {
  if (person.org_role) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge>{person.org_role.name}</Badge>
        <span className="text-xs text-muted-foreground">every tenant</span>
      </div>
    )
  }
  if (person.tenants.length === 0) {
    return <span className="text-xs text-muted-foreground">No access</span>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {person.tenants.map((t) => (
        <Badge key={t.id} variant="secondary" className="font-normal">
          {t.name}
          {t.archived && ' (archived)'} · {t.role.name}
        </Badge>
      ))}
    </div>
  )
}

function PendingConfirm({
  pending,
  onClose,
  onDone,
}: {
  pending: Pending
  onClose: () => void
  onDone: () => void
}) {
  const name = pending?.person.name ?? ''
  const id = pending?.person.user_id ?? ''
  const copy = {
    deactivate: {
      title: `Deactivate ${name}'s account?`,
      description:
        "They are signed out on every device right away and can't sign in. Their roles and tenants are kept: reactivating gives them back.",
      confirmLabel: 'Deactivate',
      destructive: true,
      run: () => orgApi.deactivate(id),
      done: `${name} deactivated`,
    },
    reactivate: {
      title: `Reactivate ${name}'s account?`,
      description:
        'They can sign in again, with the same roles and tenants as before.',
      confirmLabel: 'Reactivate',
      destructive: false,
      run: () => orgApi.reactivate(id),
      done: `${name} reactivated`,
    },
    reset: {
      title: `Send ${name} a password reset link?`,
      description: `An email goes to ${pending?.person.email ?? ''} with a link to choose a new password. It works once, for one hour. Their current password keeps working until they use it.`,
      confirmLabel: 'Send link',
      destructive: false,
      run: () => orgApi.sendPasswordReset(id),
      done: `Reset link sent to ${name}`,
    },
    two_factor: {
      title: `Reset ${name}'s two-factor sign-in?`,
      description:
        "For a lost phone and lost recovery codes. Two-factor is turned off and they are signed out everywhere. Their password still works; they set two-factor up again from their Account page (straight away if your organization requires it). They're told by email.",
      confirmLabel: 'Reset two-factor',
      destructive: true,
      run: () => orgApi.resetTwoFactor(id),
      done: `${name}'s two-factor sign-in was reset`,
    },
  }
  const c = pending ? copy[pending.kind] : copy.reset
  return (
    <ConfirmDialog
      open={pending !== null}
      title={c.title}
      description={c.description}
      confirmLabel={c.confirmLabel}
      destructive={c.destructive}
      onOpenChange={(open) => !open && onClose()}
      run={c.run}
      done={c.done}
      onDone={onDone}
    />
  )
}
