import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { AuthHeading } from '#/components/auth/auth-shell'
import { buttonVariants } from '#/components/ui/button'
import {
  FieldDescription,
  FieldGroup,
  FieldSeparator,
} from '#/components/ui/field'
import { ApiError } from '#/lib/api/api'
import { loginSchema } from '#/lib/auth/forms'
import type { TwoFactorChallenge } from '#/lib/auth/session'
import { signIn } from '#/lib/auth/session'
import { formValues, useFormAction } from '#/lib/use-form-action'

export function LoginForm({
  onSignedIn,
  onTwoFactor,
  ssoAvailable,
  redirect,
}: {
  onSignedIn: () => void
  /** The password was right; a code (or setting two-factor up) comes next. */
  onTwoFactor: (challenge: TwoFactorChallenge, email: string) => void
  /** A single sign-on connection exists: offer it. */
  ssoAvailable: boolean
  /** Passed on to the SSO page, so it returns to the same place. */
  redirect?: string
}) {
  // Set when the organization requires SSO for this email: the way through.
  const [ssoEmail, setSsoEmail] = useState<string | null>(null)
  const form = useFormAction(loginSchema, async (values) => {
    setSsoEmail(null)
    try {
      const challenge = await signIn(values.email, values.password)
      if (challenge) onTwoFactor(challenge, values.email)
      else onSignedIn()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SSO_REQUIRED')
        setSsoEmail(values.email)
      throw err
    }
  })

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
        <AuthHeading title="Sign in">
          Use the email your invitation was sent to.
        </AuthHeading>
        <FormError message={form.error} />
        {ssoEmail && (
          <Link
            to="/sso"
            search={{ email: ssoEmail, ...(redirect && { redirect }) }}
            className={buttonVariants()}
          >
            Continue with SSO
          </Link>
        )}
        <TextField
          name="email"
          label="Email"
          type="email"
          autoComplete="username"
          autoFocus
          error={form.fields.email}
        />
        <TextField
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          error={form.fields.password}
          aside={
            <Link
              to="/forgot-password"
              className="text-sm underline-offset-4 hover:underline"
            >
              Forgot your password?
            </Link>
          }
        />
        <SubmitButton pending={form.pending}>Sign in</SubmitButton>
        {ssoAvailable && (
          <>
            <FieldSeparator>or</FieldSeparator>
            <Link
              to="/sso"
              search={redirect ? { redirect } : {}}
              className={buttonVariants({ variant: 'outline' })}
            >
              Sign in with SSO
            </Link>
          </>
        )}
        <FieldDescription className="text-center">
          No account? Ask your administrator for an invitation.
        </FieldDescription>
      </FieldGroup>
    </form>
  )
}
