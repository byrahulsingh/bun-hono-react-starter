import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { useState } from 'react'

import { AuthHeading, AuthShell } from '#/components/auth/auth-shell'
import { TwoFactorSignIn } from '#/components/auth/two-factor'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { NewPasswordFields } from '#/components/auth/new-password-fields'
import { Button, buttonVariants } from '#/components/ui/button'
import {
  FieldDescription,
  FieldGroup,
  FieldSeparator,
} from '#/components/ui/field'
import { toast } from '#/components/ui/toast'
import { ApiError } from '#/lib/api/api'
import type { InvitationPreview } from '#/lib/api/auth'
import { invitationApi } from '#/lib/api/auth'
import { acceptInviteSchema } from '#/lib/auth/forms'
import {
  forgetLinkToken,
  keepLinkToken,
  linkToken,
} from '#/lib/auth/link-tokens'
import type { TwoFactorChallenge } from '#/lib/auth/session'
import {
  acceptInvitationAsNew,
  reloadMe,
  signOut,
  startSso,
} from '#/lib/auth/session'
import { useAuthStore } from '#/lib/auth/store'
import { formValues, useFormAction } from '#/lib/use-form-action'

type Loaded = { preview: InvitationPreview } | { problem: string }

/**
 * Works signed in or out: an invitation for an existing account is accepted
 * while signed in as that account; a new person creates their account here.
 */
export const Route = createFileRoute('/invite')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.token) {
      keepLinkToken('invite', search.token)
      throw redirect({ to: '/invite', search: {}, replace: true })
    }
  },
  loader: async (): Promise<Loaded> => {
    const token = linkToken('invite')
    if (!token)
      return { problem: 'Open the invitation link from your email again.' }
    try {
      return { preview: await invitationApi.preview(token) }
    } catch (err) {
      return {
        problem:
          err instanceof ApiError
            ? err.message
            : 'This invitation could not be loaded.',
      }
    }
  },
  component: InvitePage,
})

function InvitePage() {
  const loaded = Route.useLoaderData()
  return (
    <AuthShell>
      {'problem' in loaded ? (
        <FieldGroup>
          <AuthHeading title="Invitation unavailable">
            {loaded.problem}
          </AuthHeading>
          <FieldDescription className="text-center">
            <Link to="/" className="underline underline-offset-4">
              Go home
            </Link>
          </FieldDescription>
        </FieldGroup>
      ) : (
        <Invitation preview={loaded.preview} />
      )}
    </AuthShell>
  )
}

function Invitation({ preview }: { preview: InvitationPreview }) {
  const me = useAuthStore((s) => s.me)
  const place = preview.tenant_name ?? preview.organization_name
  const intro = `${preview.inviter_name ?? 'Someone'} invited you to join ${place} as ${preview.role_name}.`

  if (me && me.user.email !== preview.email) {
    return (
      <FieldGroup>
        <AuthHeading title={`Join ${place}`}>
          {intro} This invitation is for {preview.email}, but you are signed in
          as {me.user.email}.
        </AuthHeading>
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out to continue
        </Button>
      </FieldGroup>
    )
  }

  if (me) return <AcceptSignedIn intro={intro} place={place} />
  if (preview.account_exists) {
    return (
      <FieldGroup>
        <AuthHeading title={`Join ${place}`}>
          {intro} You already have an account: sign in as {preview.email} to
          accept.
        </AuthHeading>
        <Link
          to="/login"
          search={{ redirect: '/invite' }}
          className={buttonVariants()}
        >
          Sign in to accept
        </Link>
      </FieldGroup>
    )
  }
  if (preview.sso?.required) {
    return (
      <FieldGroup>
        <AuthHeading title={`Join ${place}`}>
          {intro} Your organization signs in with {preview.sso.name}: your
          account is made when you sign in there as {preview.email}.
        </AuthHeading>
        <SsoButton email={preview.email} name={preview.sso.name} />
      </FieldGroup>
    )
  }
  return (
    <CreateAccount
      intro={intro}
      place={place}
      email={preview.email}
      sso={preview.sso}
    />
  )
}

/** Signing in through the provider accepts every open invitation for that email. */
function SsoButton({
  email,
  name,
  variant = 'default',
}: {
  email: string
  name: string
  variant?: 'default' | 'outline'
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <FormError message={error} />
      <Button
        type="button"
        variant={variant}
        disabled={pending}
        aria-busy={pending}
        onClick={() => {
          setPending(true)
          setError(null)
          startSso(email).catch((err: unknown) => {
            setPending(false)
            setError(
              err instanceof ApiError
                ? err.message
                : 'Something went wrong. Try again.',
            )
          })
        }}
      >
        Continue with {name}
      </Button>
    </>
  )
}

function AcceptSignedIn({ intro, place }: { intro: string; place: string }) {
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function accept() {
    const token = linkToken('invite')
    if (!token || pending) return
    setPending(true)
    setError(null)
    try {
      await invitationApi.acceptSignedIn(token)
      forgetLinkToken('invite')
      await reloadMe()
      toast.add({ title: `You joined ${place}`, type: 'success' })
      await navigate({ to: '/', replace: true })
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Something went wrong. Try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <FieldGroup>
      <AuthHeading title={`Join ${place}`}>{intro}</AuthHeading>
      <FormError message={error} />
      <Button
        onClick={() => void accept()}
        disabled={pending}
        aria-busy={pending}
      >
        Accept invitation
      </Button>
    </FieldGroup>
  )
}

function CreateAccount({
  intro,
  place,
  email,
  sso,
}: {
  intro: string
  place: string
  email: string
  /** Offered as well as a password. */
  sso: InvitationPreview['sso']
}) {
  const navigate = useNavigate()
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null)
  const welcome = async () => {
    toast.add({ title: `Welcome to ${place}`, type: 'success' })
    await navigate({ to: '/', replace: true })
  }
  const form = useFormAction(acceptInviteSchema, async (values) => {
    const token = linkToken('invite')
    if (!token) return
    const next = await acceptInvitationAsNew({
      token,
      name: values.name,
      password: values.password,
    })
    forgetLinkToken('invite')
    // The organization requires two-factor: set it up before going in.
    if (next) setChallenge(next)
    else await welcome()
  })

  if (challenge) {
    return (
      <TwoFactorSignIn
        challenge={challenge}
        account={email}
        onSignedIn={() => void welcome()}
        // The account exists now; signing in carries on from here.
        onRestart={() => void navigate({ to: '/login', replace: true })}
      />
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
        <AuthHeading title={`Join ${place}`}>{intro}</AuthHeading>
        {sso && (
          <>
            <SsoButton email={email} name={sso.name} variant="outline" />
            <FieldSeparator>or choose a password</FieldSeparator>
          </>
        )}
        <FormError message={form.error} />
        {/* Shown, not editable: the account is for the address the invitation went to. */}
        <TextField
          name="email_display"
          label="Email"
          type="email"
          value={email}
          readOnly
          autoComplete="username"
        />
        <TextField
          name="name"
          label="Your name"
          autoComplete="name"
          autoFocus
          error={form.fields.name}
        />
        <NewPasswordFields errors={form.fields} />
        <SubmitButton pending={form.pending}>Create account</SubmitButton>
      </FieldGroup>
    </form>
  )
}
