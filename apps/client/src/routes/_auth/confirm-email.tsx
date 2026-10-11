import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'

import { AuthHeading } from '#/components/auth/auth-shell'
import { FormError, SubmitButton } from '#/components/auth/form-parts'
import { buttonVariants } from '#/components/ui/button'
import { FieldDescription, FieldGroup } from '#/components/ui/field'
import { ApiError } from '#/lib/api/api'
import { authApi } from '#/lib/api/auth'
import {
  forgetLinkToken,
  keepLinkToken,
  linkToken,
} from '#/lib/auth/link-tokens'
import { reloadMe } from '#/lib/auth/session'
import { useAuthStore } from '#/lib/auth/store'

/**
 * The link sent to a new sign-in email. Confirmed with a button, not on
 * opening: mail scanners open links on their own. Works signed in or out.
 */
export const Route = createFileRoute('/_auth/confirm-email')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.token) {
      keepLinkToken('confirm-email', search.token)
      throw redirect({ to: '/confirm-email', search: {}, replace: true })
    }
  },
  component: ConfirmEmailPage,
})

function ConfirmEmailPage() {
  const token = linkToken('confirm-email')
  const signedIn = useAuthStore((s) => s.status === 'signed-in')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function confirm() {
    if (!token) return
    setPending(true)
    setError(null)
    try {
      const { email } = await authApi.confirmEmailChange(token)
      forgetLinkToken('confirm-email')
      // Signed in here as that person: show the new address straight away.
      if (signedIn) await reloadMe().catch(() => {})
      setDone(email)
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

  if (done) {
    return (
      <FieldGroup>
        <AuthHeading title="Email changed">
          You now sign in with {done}.
        </AuthHeading>
        <Link to="/" className={buttonVariants()}>
          {signedIn ? 'Continue' : 'Sign in'}
        </Link>
      </FieldGroup>
    )
  }

  if (!token) {
    return (
      <FieldGroup>
        <AuthHeading title="Link expired">
          Open the link from your email again, or ask for a new one on your
          Account page.
        </AuthHeading>
        <FieldDescription className="text-center">
          <Link to="/" className="underline underline-offset-4">
            Go home
          </Link>
        </FieldDescription>
      </FieldGroup>
    )
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        void confirm()
      }}
    >
      <FieldGroup>
        <AuthHeading title="Use this email to sign in?">
          Your sign-in email changes to the address this link was sent to. Your
          old address gets a notice.
        </AuthHeading>
        <FormError message={error} />
        <SubmitButton pending={pending}>Use this email</SubmitButton>
      </FieldGroup>
    </form>
  )
}
