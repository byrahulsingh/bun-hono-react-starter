import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { AuthHeading } from '#/components/auth/auth-shell'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { FieldDescription, FieldGroup } from '#/components/ui/field'
import { authApi } from '#/lib/api/auth'
import { forgotSchema } from '#/lib/auth/forms'
import { formValues, useFormAction } from '#/lib/use-form-action'

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null)
  const form = useFormAction(forgotSchema, async (values) => {
    await authApi.forgotPassword(values.email)
    setSentTo(values.email)
  })

  if (sentTo) {
    // The same answer whether or not the account exists.
    return (
      <FieldGroup>
        <AuthHeading title="Check your email">
          If an account exists for {sentTo}, a link to choose a new password is
          on its way. It expires in 1 hour.
        </AuthHeading>
        <FieldDescription className="text-center">
          <Link to="/login" className="underline underline-offset-4">
            Back to sign in
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
        <AuthHeading title="Forgot your password?">
          Enter your email and we'll send you a link to choose a new one.
        </AuthHeading>
        <FormError message={form.error} />
        <TextField
          name="email"
          label="Email"
          type="email"
          autoComplete="username"
          autoFocus
          error={form.fields.email}
        />
        <SubmitButton pending={form.pending}>Send link</SubmitButton>
        <FieldDescription className="text-center">
          <Link to="/login" className="underline underline-offset-4">
            Back to sign in
          </Link>
        </FieldDescription>
      </FieldGroup>
    </form>
  )
}
