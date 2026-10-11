import {
  MailIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-react'
import { useState } from 'react'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { toast } from '#/components/ui/toast'
import { ApiError } from '#/lib/api/api'
import type { Invitation } from '#/lib/api/people'

/** Building blocks shared by the People, Admins and Tenants pages. */

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
export const formatDate = (iso: string) => date.format(new Date(iso))

export function errorMessage(err: unknown) {
  return err instanceof ApiError
    ? err.message
    : 'Something went wrong. Try again.'
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  )
}

export function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="overflow-hidden rounded-lg border">{children}</div>
    </section>
  )
}

/** The ⋯ menu at the end of a row. */
export function RowActions({
  label,
  actions,
}: {
  /** For screen readers: "Actions for Ed Editor". */
  label: string
  actions: { label: string; onSelect: () => void; destructive?: boolean }[]
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label={label} />}
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            variant={action.destructive ? 'destructive' : 'default'}
            onClick={action.onSelect}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Open (pending or expired) invitations, with resend and revoke. */
export function InvitationsTable({
  invitations,
  resend,
  revoke,
  onChanged,
}: {
  invitations: Invitation[]
  resend: (invitation: Invitation) => Promise<unknown>
  revoke: (invitation: Invitation) => Promise<unknown>
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const open = invitations.filter(
    (i) => i.status === 'pending' || i.status === 'expired',
  )

  async function act(id: string, run: () => Promise<unknown>, done: string) {
    if (busy) return
    setBusy(id)
    try {
      await run()
      toast.add({ title: done, type: 'success' })
      onChanged()
    } catch (err) {
      toast.add({ title: errorMessage(err), type: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section
      title="Invitations"
      description="Waiting to be accepted. Resending sends a new link and voids the old one."
    >
      {open.length === 0 ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <MailIcon className="size-4" aria-hidden="true" />
          No open invitations.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="hidden sm:table-cell">Sent</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {open.map((inv) => (
              <TableRow key={inv.id} aria-busy={busy === inv.id}>
                <TableCell>
                  <div className="font-medium">{inv.email}</div>
                  {inv.status === 'expired' && (
                    <Badge variant="outline" className="mt-1">
                      Expired
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{inv.role.name}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {formatDate(inv.created_at)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          inv.id,
                          () => resend(inv),
                          `New link sent to ${inv.email}`,
                        )
                      }
                    >
                      <RefreshCwIcon aria-hidden="true" />
                      Resend
                    </Button>
                    {inv.status === 'pending' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(
                            inv.id,
                            () => revoke(inv),
                            `Invitation to ${inv.email} revoked`,
                          )
                        }
                      >
                        <XIcon aria-hidden="true" />
                        Revoke
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}
