import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { FormError, SubmitButton } from '#/components/auth/form-parts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Button } from '#/components/ui/button'
import { Field, FieldError, FieldLabel } from '#/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Textarea } from '#/components/ui/textarea'
import { toast } from '#/components/ui/toast'
import { ApiError } from '#/lib/api/api'
import type { AssignableRole, BulkInviteResult } from '#/lib/api/people'
import { formValues, useFormAction } from '#/lib/use-form-action'

const roleId = z.string().min(1, 'Choose a role')
const changeRoleSchema = z.object({ role_id: roleId })

/**
 * Dialogs for giving people access, shared by a tenant's People page and the
 * organization's Admins page. They know nothing about which API they call:
 * the page passes the action in.
 */

/**
 * A role picker that submits `role_id` with the form. Roles carrying a
 * permission you lack are shown but disabled: the server would refuse them.
 */
export function RoleField({
  roles,
  defaultValue,
  error,
  onChange,
}: {
  roles: AssignableRole[]
  defaultValue?: string
  error?: string
  onChange: () => void
}) {
  const [selected, setSelected] = useState(defaultValue ?? null)
  const description = roles.find((r) => r.id === selected)?.description
  const errorId = 'role_id-error'
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor="role_id">Role</FieldLabel>
      <Select
        name="role_id"
        items={Object.fromEntries(roles.map((r) => [r.id, r.name]))}
        defaultValue={defaultValue ?? null}
        onValueChange={(value) => {
          setSelected(value)
          onChange()
        }}
      >
        <SelectTrigger
          id="role_id"
          className="w-full"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        >
          <SelectValue placeholder="Choose a role" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {roles.map((role) => (
            <SelectItem
              key={role.id}
              value={role.id}
              disabled={!role.assignable}
            >
              {role.name}
              {!role.assignable && (
                <span className="text-xs text-muted-foreground">
                  more access than yours
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  )
}

function FormDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The form lives inside the popup, so every opening starts clean. */}
      <DialogContent>{children}</DialogContent>
    </Dialog>
  )
}

// ─── Invite ──────────────────────────────────────────────────────

const MAX_INVITES = 50

/**
 * Every address in pasted text: a list, a spreadsheet column, `Name <a@b.c>`
 * lines or an email thread. Anything with an @ counts; the server checks
 * each one properly. Repeats are kept once.
 */
export function parseAddresses(text: string): string[] {
  const found = text.match(/[^\s<>,;"'()[\]]+@[^\s<>,;"'()[\]]+/g) ?? []
  const seen = new Set<string>()
  return found.filter((address) => {
    const key = address.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const inviteSchema = z.object({
  emails: z
    .string()
    .transform(parseAddresses)
    .pipe(
      z
        .array(z.string())
        .min(1, 'Enter at least one email address')
        .max(MAX_INVITES, `At most ${MAX_INVITES} at a time`),
    ),
  role_id: roleId,
})

type Invite = (input: {
  emails: string[]
  role_id: string
}) => Promise<{ results: BulkInviteResult[] }>

export function InviteDialog({
  title,
  roles,
  open,
  onOpenChange,
  invite,
  onDone,
}: {
  /** e.g. "Invite to Beta Clients" or "Invite an admin". */
  title: string
  roles: AssignableRole[]
  open: boolean
  onOpenChange: (open: boolean) => void
  invite: Invite
  /** After anything was sent: refresh the page's lists. */
  onDone: () => void
}) {
  return (
    <FormDialog open={open} onOpenChange={onOpenChange}>
      <InviteForm
        title={title}
        roles={roles}
        invite={invite}
        onSent={onDone}
        onClose={() => onOpenChange(false)}
      />
    </FormDialog>
  )
}

const OUTCOME: Record<BulkInviteResult['status'], string> = {
  sent: 'Invitation sent',
  resent: 'Already invited: new link sent',
  skipped: 'Not invited',
  invalid: 'Not invited',
  failed: 'Not sent',
}

function InviteForm({
  title,
  roles,
  invite,
  onSent,
  onClose,
}: {
  title: string
  roles: AssignableRole[]
  invite: Invite
  onSent: () => void
  onClose: () => void
}) {
  const [count, setCount] = useState(0)
  const [results, setResults] = useState<BulkInviteResult[] | null>(null)
  const form = useFormAction(inviteSchema, async (values) => {
    const { results: outcome } = await invite(values)
    const sent = outcome.filter(
      (r) => r.status === 'sent' || r.status === 'resent',
    )
    if (sent.length > 0) onSent()
    // All went out: a toast is enough. Otherwise show who was not invited, and why.
    if (sent.length === outcome.length) {
      toast.add({
        title:
          sent.length === 1
            ? `Invitation sent to ${sent[0].email}`
            : `${sent.length} invitations sent`,
        type: 'success',
      })
      onClose()
    } else {
      setResults(outcome)
    }
  })

  if (results) return <InviteResults results={results} onClose={onClose} />

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onInput={(event) => {
        const { name } = event.target as HTMLInputElement
        form.clearField(name)
      }}
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Each person gets an email with a link, valid for 7 days. Inviting an
          address again replaces its earlier link.
        </DialogDescription>
      </DialogHeader>
      <FormError message={form.error} />
      <Field data-invalid={form.fields.emails ? true : undefined}>
        <FieldLabel htmlFor="emails">Emails</FieldLabel>
        <Textarea
          id="emails"
          name="emails"
          rows={3}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="ada@example.com, ben@example.com"
          aria-invalid={form.fields.emails ? true : undefined}
          aria-describedby="emails-hint"
          onChange={(event) =>
            setCount(parseAddresses(event.target.value).length)
          }
          className="max-h-48"
        />
        <p id="emails-hint" className="text-xs text-muted-foreground">
          {count > 1
            ? `${count} addresses. They all get the role below.`
            : `One or more, separated by commas or new lines. Pasting from a spreadsheet works. Up to ${MAX_INVITES}.`}
        </p>
        {form.fields.emails && <FieldError>{form.fields.emails}</FieldError>}
      </Field>
      <RoleField
        roles={roles}
        error={form.fields.role_id}
        onChange={() => form.clearField('role_id')}
      />
      <DialogFooter>
        <SubmitButton pending={form.pending}>
          {count > 1 ? `Send ${count} invitations` : 'Send invitation'}
        </SubmitButton>
      </DialogFooter>
    </form>
  )
}

function InviteResults({
  results,
  onClose,
}: {
  results: BulkInviteResult[]
  onClose: () => void
}) {
  const sent = results.filter(
    (r) => r.status === 'sent' || r.status === 'resent',
  ).length
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>
          {sent === 0
            ? 'No invitations sent'
            : `${sent} of ${results.length} invitations sent`}
        </DialogTitle>
        <DialogDescription>
          The others were not invited, for the reasons below.
        </DialogDescription>
      </DialogHeader>
      <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-lg border text-sm">
        {results.map((r) => {
          const ok = r.status === 'sent' || r.status === 'resent'
          return (
            <li key={r.email} className="flex items-start gap-2 px-3 py-2">
              {ok ? (
                <CircleCheckIcon
                  className="mt-0.5 size-4 shrink-0 text-emerald-600"
                  aria-label="Sent"
                />
              ) : (
                <CircleAlertIcon
                  className="mt-0.5 size-4 shrink-0 text-amber-600"
                  aria-label="Not sent"
                />
              )}
              <div className="min-w-0">
                <div className="font-medium break-words">{r.email}</div>
                <div className="text-xs text-muted-foreground">
                  {r.message ?? OUTCOME[r.status]}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </div>
  )
}

// ─── Change role ─────────────────────────────────────────────────

export interface PersonWithRole {
  name: string
  email: string
  role: { id: string }
}

export function ChangeRoleDialog({
  person,
  roles,
  description,
  onOpenChange,
  change,
  onDone,
}: {
  /** The person being changed; null = closed. */
  person: PersonWithRole | null
  roles: AssignableRole[]
  /** What the change means here, e.g. "The change applies right away." */
  description: string
  onOpenChange: (open: boolean) => void
  change: (roleId: string) => Promise<unknown>
  onDone: () => void
}) {
  return (
    <FormDialog open={person !== null} onOpenChange={onOpenChange}>
      {person && (
        <ChangeRoleForm
          person={person}
          roles={roles}
          description={description}
          change={change}
          onDone={() => {
            onOpenChange(false)
            onDone()
          }}
        />
      )}
    </FormDialog>
  )
}

function ChangeRoleForm({
  person,
  roles,
  description,
  change,
  onDone,
}: {
  person: PersonWithRole
  roles: AssignableRole[]
  description: string
  change: (roleId: string) => Promise<unknown>
  onDone: () => void
}) {
  const form = useFormAction(changeRoleSchema, async (values) => {
    await change(values.role_id)
    toast.add({ title: `${person.name}'s role changed`, type: 'success' })
    onDone()
  })
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <DialogHeader>
        <DialogTitle>Change role</DialogTitle>
        <DialogDescription>
          {person.name} ({person.email}). {description}
        </DialogDescription>
      </DialogHeader>
      <FormError message={form.error} />
      <RoleField
        roles={roles}
        defaultValue={person.role.id}
        error={form.fields.role_id}
        onChange={() => form.clearField('role_id')}
      />
      <DialogFooter>
        <SubmitButton pending={form.pending}>Save</SubmitButton>
      </DialogFooter>
    </form>
  )
}

// ─── Confirm (remove, archive, ...) ──────────────────────────────

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = true,
  onOpenChange,
  run,
  done,
  onDone,
}: {
  open: boolean
  title: string
  description: React.ReactNode
  confirmLabel: string
  destructive?: boolean
  onOpenChange: (open: boolean) => void
  run: () => Promise<unknown>
  /** Toast after it worked. */
  done: string
  onDone: () => void
}) {
  const [pending, setPending] = useState(false)

  async function confirm() {
    if (pending) return
    setPending(true)
    try {
      await run()
      toast.add({ title: done, type: 'success' })
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.add({
        title:
          err instanceof ApiError
            ? err.message
            : 'Something went wrong. Try again.',
        type: 'error',
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            aria-busy={pending}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
