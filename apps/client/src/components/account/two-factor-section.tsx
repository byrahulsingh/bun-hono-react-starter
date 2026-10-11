import { ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { FormSection } from '#/components/app/form-section'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import {
  CodeField,
  RecoveryCodes,
  TwoFactorEnroll,
} from '#/components/auth/two-factor'
import { formatDate } from '#/components/people/people-parts'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { toast } from '#/components/ui/toast'
import type { TwoFactorStatus } from '#/lib/api/auth'
import { accountApi } from '#/lib/api/auth'
import { useMe } from '#/lib/auth/store'
import { formValues, useFormAction } from '#/lib/use-form-action'

const passwordSchema = z.object({ password: z.string().min(1, 'Required') })
const codeSchema = z.object({
  code: z.string().trim().min(1, 'Enter the code'),
})
const disableSchema = passwordSchema.extend(codeSchema.shape)

type Flow = 'enable' | 'codes' | 'disable' | null

/** Two-factor sign-in on the Account page: on, new recovery codes, off. */
export function TwoFactorSection({
  status,
  onChanged,
}: {
  status: TwoFactorStatus
  onChanged: () => Promise<void>
}) {
  const [flow, setFlow] = useState<Flow>(null)
  // While recovery codes are on screen, the dialog does not close by accident.
  const [showingCodes, setShowingCodes] = useState(false)

  const close = () => {
    setFlow(null)
    setShowingCodes(false)
    void onChanged()
  }

  return (
    <FormSection
      title="Two-factor sign-in"
      description="A code from an authenticator app on your phone, as well as your password, when you sign in on a device."
    >
      <div className="flex flex-col items-start gap-3">
        {status.enabled ? (
          <>
            <p className="flex items-center gap-2 text-sm">
              <Badge>
                <ShieldCheckIcon aria-hidden="true" />
                On
              </Badge>
              <span className="text-muted-foreground">
                since {formatDate(status.enabled_at!)} ·{' '}
                {status.recovery_codes_left} recovery code
                {status.recovery_codes_left === 1 ? '' : 's'} left
              </span>
            </p>
            {status.recovery_codes_left <= 2 && (
              <p className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
                <TriangleAlertIcon className="size-4" aria-hidden="true" />
                Running low on recovery codes: make a new set.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setFlow('codes')}>
                New recovery codes
              </Button>
              <Button
                variant="ghost"
                disabled={status.required}
                onClick={() => setFlow('disable')}
              >
                Turn off
              </Button>
            </div>
            {status.required && (
              <p className="text-sm text-muted-foreground">
                Your organization requires two-factor sign-in, so it stays on.
                If you lose your phone and your recovery codes, an admin can
                reset it.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Off. Signing in needs only your password.
            </p>
            {status.required && (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                Your organization requires it: you will be asked to set it up at
                your next sign-in.
              </p>
            )}
            <Button onClick={() => setFlow('enable')}>Turn on</Button>
          </>
        )}
      </div>

      <Dialog
        open={flow !== null}
        onOpenChange={(open) => {
          if (!open && !showingCodes) close()
        }}
      >
        <DialogContent className="sm:max-w-md">
          {flow === 'enable' && (
            <EnableFlow onCodes={() => setShowingCodes(true)} onDone={close} />
          )}
          {flow === 'codes' && (
            <NewCodesFlow
              onCodes={() => setShowingCodes(true)}
              onDone={close}
            />
          )}
          {flow === 'disable' && <DisableFlow onDone={close} />}
        </DialogContent>
      </Dialog>
    </FormSection>
  )
}

function EnableFlow({
  onCodes,
  onDone,
}: {
  onCodes: () => void
  onDone: () => void
}) {
  const me = useMe()
  const [secret, setSecret] = useState<string | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const form = useFormAction(passwordSchema, async ({ password }) => {
    setSecret((await accountApi.beginTwoFactor(password)).secret)
  })

  if (codes) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Save your recovery codes</DialogTitle>
          <DialogDescription>Two-factor sign-in is on.</DialogDescription>
        </DialogHeader>
        <RecoveryCodes
          codes={codes}
          doneLabel="Done"
          onDone={() => {
            toast.add({ title: 'Two-factor sign-in is on', type: 'success' })
            onDone()
          }}
        />
      </>
    )
  }

  if (secret) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Set up your authenticator app</DialogTitle>
        </DialogHeader>
        <TwoFactorEnroll
          account={me.user.email}
          start={() => Promise.resolve(secret)}
          finish={async (code) =>
            (await accountApi.confirmTwoFactor(code)).recovery_codes
          }
          onCodes={(next) => {
            setCodes(next)
            onCodes()
          }}
        />
      </>
    )
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onInput={() => form.clearField('password')}
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <DialogHeader>
        <DialogTitle>Turn on two-factor sign-in</DialogTitle>
        <DialogDescription>First, confirm it's you.</DialogDescription>
      </DialogHeader>
      <FormError message={form.error} />
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
        autoFocus
        error={form.fields.password}
      />
      <div>
        <SubmitButton pending={form.pending}>Continue</SubmitButton>
      </div>
    </form>
  )
}

function NewCodesFlow({
  onCodes,
  onDone,
}: {
  onCodes: () => void
  onDone: () => void
}) {
  const [codes, setCodes] = useState<string[] | null>(null)
  const form = useFormAction(codeSchema, async ({ code }) => {
    setCodes((await accountApi.newRecoveryCodes(code)).recovery_codes)
    onCodes()
  })

  if (codes) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Your new recovery codes</DialogTitle>
          <DialogDescription>The old ones no longer work.</DialogDescription>
        </DialogHeader>
        <RecoveryCodes codes={codes} doneLabel="Done" onDone={onDone} />
      </>
    )
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onInput={() => form.clearField('code')}
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <DialogHeader>
        <DialogTitle>New recovery codes</DialogTitle>
        <DialogDescription>
          Makes a new set; the old codes stop working. Enter a code from your
          app to confirm.
        </DialogDescription>
      </DialogHeader>
      <FormError message={form.error} />
      <CodeField error={form.fields.code} kind="either" />
      <div>
        <SubmitButton pending={form.pending}>Make new codes</SubmitButton>
      </div>
    </form>
  )
}

function DisableFlow({ onDone }: { onDone: () => void }) {
  const me = useMe()
  const form = useFormAction(disableSchema, async (values) => {
    await accountApi.disableTwoFactor(values)
    toast.add({ title: 'Two-factor sign-in is off', type: 'success' })
    onDone()
  })

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
        <DialogTitle>Turn off two-factor sign-in?</DialogTitle>
        <DialogDescription>
          Signing in will need only your password. Your password and a code (or
          a recovery code) confirm it's you.
        </DialogDescription>
      </DialogHeader>
      <FormError message={form.error} />
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
        autoFocus
        error={form.fields.password}
      />
      <CodeField error={form.fields.code} kind="either" autoFocus={false} />
      <div>
        <SubmitButton pending={form.pending}>Turn off</SubmitButton>
      </div>
    </form>
  )
}
