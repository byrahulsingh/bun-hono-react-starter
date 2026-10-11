import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'

import { AuthHeading } from '#/components/auth/auth-shell'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { NewPasswordFields } from '#/components/auth/new-password-fields'
import {
  FieldDescription,
  FieldGroup,
  FieldSeparator,
} from '#/components/ui/field'
import { setupApi } from '#/lib/api/auth'
import { setupSchema } from '#/lib/auth/forms'
import {
  forgetLinkToken,
  keepLinkToken,
  linkToken,
} from '#/lib/auth/link-tokens'
import { completeSetup } from '#/lib/auth/session'
import { useAuthStore } from '#/lib/auth/store'
import { formValues, useFormAction } from '#/lib/use-form-action'

export const Route = createFileRoute('/_auth/setup')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.token) {
      keepLinkToken('setup', search.token)
      throw redirect({ to: '/setup', search: {}, replace: true })
    }
    if (useAuthStore.getState().status === 'signed-in')
      throw redirect({ to: '/' })
  },
  loader: () => setupApi.status(),
  component: SetupPage,
})

function SetupPage() {
  const { needs_setup } = Route.useLoaderData()
  const navigate = useNavigate()
  const token = linkToken('setup')
  const form = useFormAction(
    setupSchema,
    async ({ confirm_password: _, ...values }) => {
      if (!token) return
      await completeSetup({ ...values, token })
      forgetLinkToken('setup')
      await navigate({ to: '/', replace: true })
    },
  )

  if (!needs_setup) {
    return (
      <FieldGroup>
        <AuthHeading title="Already set up">
          This install has an owner. Sign in instead.
        </AuthHeading>
        <FieldDescription className="text-center">
          <Link to="/login" className="underline underline-offset-4">
            Go to sign in
          </Link>
        </FieldDescription>
      </FieldGroup>
    )
  }

  if (!token) {
    return (
      <AuthHeading title="Setup link needed">
        Open the one-time setup link printed in the server log when it started.
      </AuthHeading>
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
        <AuthHeading title="Set up your workspace">
          You'll be the owner. You can invite your team next.
        </AuthHeading>
        <FormError message={form.error} />
        <TextField
          name="organization_name"
          label="Organization name"
          autoComplete="organization"
          autoFocus
          error={form.fields.organization_name}
        />
        <FieldSeparator>Your account</FieldSeparator>
        <TextField
          name="name"
          label="Your name"
          autoComplete="name"
          error={form.fields.name}
        />
        <TextField
          name="email"
          label="Email"
          type="email"
          autoComplete="username"
          error={form.fields.email}
        />
        <NewPasswordFields errors={form.fields} />
        <SubmitButton pending={form.pending}>Create workspace</SubmitButton>
      </FieldGroup>
    </form>
  )
}
