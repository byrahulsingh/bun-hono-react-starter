import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { useState } from 'react'

import { AuthHeading } from '#/components/auth/auth-shell'
import { FormError, SubmitButton } from '#/components/auth/form-parts'
import { NewPasswordFields } from '#/components/auth/new-password-fields'
import { TwoFactorSignIn } from '#/components/auth/two-factor'
import { FieldDescription, FieldGroup } from '#/components/ui/field'
import { toast } from '#/components/ui/toast'
import { resetSchema } from '#/lib/auth/forms'
import {
  forgetLinkToken,
  keepLinkToken,
  linkToken,
} from '#/lib/auth/link-tokens'
import type { TwoFactorChallenge } from '#/lib/auth/session'
import { resetPassword } from '#/lib/auth/session'
import { formValues, useFormAction } from '#/lib/use-form-action'

export const Route = createFileRoute('/_auth/reset-password')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  beforeLoad: ({ search }) => {
    // Take the token out of the address bar at once; keep it in memory only.
    if (search.token) {
      keepLinkToken('reset', search.token)
      throw redirect({ to: '/reset-password', search: {}, replace: true })
    }
  },
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const navigate = useNavigate()
  const token = linkToken('reset')
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null)
  const finished = async () => {
    toast.add({
      title: 'Password changed',
      description: 'Other devices were signed out.',
      type: 'success',
    })
    await navigate({ to: '/', replace: true })
  }
  const form = useFormAction(resetSchema, async (values) => {
    if (!token) return
    const next = await resetPassword(token, values.password)
    forgetLinkToken('reset')
    // With two-factor on, the link alone is not enough: the code comes next.
    if (next) setChallenge(next)
    else await finished()
  })

  if (challenge) {
    return (
      <TwoFactorSignIn
        challenge={challenge}
        onSignedIn={() => void finished()}
        // The password is already changed; signing in normally finishes.
        onRestart={() => void navigate({ to: '/login', replace: true })}
      />
    )
  }

  if (!token) {
    return (
      <FieldGroup>
        <AuthHeading title="Link expired">
          Open the link from your email again, or ask for a new one.
        </AuthHeading>
        <FieldDescription className="text-center">
          <Link to="/forgot-password" className="underline underline-offset-4">
            Send a new link
          </Link>
        </FieldDescription>
      </FieldGroup>
    )
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <FieldGroup>
        <AuthHeading title="Choose a new password">
          At least 10 characters. A short sentence works well.
        </AuthHeading>
        <FormError message={form.error} />
        <NewPasswordFields errors={form.fields} />
        <SubmitButton pending={form.pending}>
          Change password and sign in
        </SubmitButton>
      </FieldGroup>
    </form>
  )
}
