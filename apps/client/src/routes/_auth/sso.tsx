import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

import { AuthHeading } from '#/components/auth/auth-shell'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { FieldDescription, FieldGroup } from '#/components/ui/field'
import { email } from '#/lib/auth/forms'
import { safeRedirect } from '#/lib/auth/redirect'
import { startSso } from '#/lib/auth/session'
import { useAuthStore } from '#/lib/auth/store'
import { formValues, useFormAction } from '#/lib/use-form-action'

const ssoSchema = z.object({ email })

/** Single sign-on: the work email picks the organization's provider. */
export const Route = createFileRoute('/_auth/sso')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { email?: string; redirect?: string } => ({
    email: typeof search.email === 'string' ? search.email : undefined,
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (useAuthStore.getState().status === 'signed-in')
      throw redirect({ href: safeRedirect(search.redirect) })
  },
  component: SsoPage,
})

function SsoPage() {
  const search = Route.useSearch()
  const form = useFormAction(ssoSchema, async (values) => {
    await startSso(values.email, safeRedirect(search.redirect))
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
        <AuthHeading title="Sign in with SSO">
          Enter your work email. We'll send you to your organization's sign-in
          page.
        </AuthHeading>
        <FormError message={form.error} />
        <TextField
          name="email"
          label="Work email"
          type="email"
          autoComplete="username"
          autoFocus
          defaultValue={search.email}
          error={form.fields.email}
        />
        <SubmitButton pending={form.pending}>Continue</SubmitButton>
        <FieldDescription className="text-center">
          <Link
            to="/login"
            search={search.redirect ? { redirect: search.redirect } : {}}
            className="underline underline-offset-4"
          >
            Sign in with a password instead
          </Link>
        </FieldDescription>
      </FieldGroup>
    </form>
  )
}
