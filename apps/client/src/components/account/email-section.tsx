import { MailIcon } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { FormSection } from '#/components/app/form-section'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { CodeField } from '#/components/auth/two-factor'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { toast } from '#/components/ui/toast'
import { ApiError } from '#/lib/api/api'
import type { PendingEmailChange } from '#/lib/api/auth'
import { accountApi } from '#/lib/api/auth'
import { email } from '#/lib/auth/forms'
import { useMe } from '#/lib/auth/store'
import { formValues, useFormAction } from '#/lib/use-form-action'

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const changeSchema = z.object({
  new_email: email,
  password: z.string().min(1, 'Required'),
})
const changeWithCodeSchema = changeSchema.extend({
  code: z.string().trim().min(1, 'Enter the code'),
})

/**
 * The sign-in email on the Account page. Changing it sends a link to the new
 * address; nothing changes until that link is opened.
 */
export function EmailSection({
  pending,
  twoFactor,
  managedBy,
  onChanged,
}: {
  pending: PendingEmailChange | null
  /** Two-factor is on: changing the email needs a code too. */
  twoFactor: boolean
  /** Signed in only through this SSO connection: the email is the provider's to change. */
  managedBy?: string
  onChanged: () => Promise<void>
}) {
  const me = useMe()
  const [open, setOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  async function cancel() {
    setCancelling(true)
    try {
      await accountApi.cancelEmailChange()
      toast.add({ title: 'Email change cancelled', type: 'success' })
      await onChanged()
    } catch (err) {
      toast.add({
        title:
          err instanceof ApiError
            ? err.message
            : 'Something went wrong. Try again.',
        type: 'error',
      })
    } finally {
      setCancelling(false)
    }
  }

  return (
    <FormSection
      title="Sign-in email"
      description="Where your sign-in links and security notices go."
    >
      <div className="flex flex-col items-start gap-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <MailIcon
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {me.user.email}
        </p>
        {pending && (
          <div
            className="rounded-lg border bg-muted/40 p-3 text-sm"
            role="status"
          >
            Waiting for confirmation: we sent a link to{' '}
            <strong className="font-medium">{pending.new_email}</strong>. It
            expires {dateTime.format(new Date(pending.expires_at))}.{' '}
            <Button
              variant="link"
              className="h-auto p-0"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              Cancel the change
            </Button>
          </div>
        )}
        {managedBy ? (
          <p className="text-sm text-muted-foreground">
            You sign in with {managedBy}; ask your administrator to change your
            email.
          </p>
        ) : (
          <Button variant="outline" onClick={() => setOpen(true)}>
            Change email
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          {open && (
            <ChangeEmailForm
              twoFactor={twoFactor}
              onDone={async (newEmail) => {
                setOpen(false)
                toast.add({
                  title: 'Check your new inbox',
                  description: `We sent a confirmation link to ${newEmail}.`,
                  type: 'success',
                })
                await onChanged()
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </FormSection>
  )
}

function ChangeEmailForm({
  twoFactor,
  onDone,
}: {
  twoFactor: boolean
  onDone: (newEmail: string) => Promise<void>
}) {
  const me = useMe()
  const form = useFormAction(
    twoFactor ? changeWithCodeSchema : changeSchema,
    async (values) => {
      const pending = await accountApi.changeEmail(values)
      await onDone(pending.new_email)
    },
  )

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onInput={(event) =>
        form.clearField((event.target as HTMLInputElement).name)
      }
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <DialogHeader>
        <DialogTitle>Change your sign-in email</DialogTitle>
        <DialogDescription>
          We'll send a link to the new address. Your email changes when you open
          it, and {me.user.email} gets a notice.
        </DialogDescription>
      </DialogHeader>
      <FormError message={form.error} />
      <TextField
        name="new_email"
        label="New email"
        type="email"
        autoComplete="email"
        autoFocus
        error={form.fields.new_email}
      />
      {/* For password managers: which account this password belongs to. */}
      <input
        type="email"
        name="username"
        autoComplete="username"
        value={me.user.email}
        readOnly
        hidden
      />
      <TextField
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        error={form.fields.password}
      />
      {twoFactor && (
        <CodeField error={form.fields.code} kind="either" autoFocus={false} />
      )}
      <div>
        <SubmitButton pending={form.pending}>
          Send confirmation link
        </SubmitButton>
      </div>
    </form>
  )
}
