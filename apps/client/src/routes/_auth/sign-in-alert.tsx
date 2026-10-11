import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { MonitorIcon, SmartphoneIcon } from 'lucide-react'
import { useState } from 'react'

import { AuthHeading } from '#/components/auth/auth-shell'
import { FormError, SubmitButton } from '#/components/auth/form-parts'
import { buttonVariants } from '#/components/ui/button'
import { FieldDescription, FieldGroup } from '#/components/ui/field'
import { ApiError } from '#/lib/api/api'
import type { SignInAlertPreview } from '#/lib/api/auth'
import { authApi } from '#/lib/api/auth'
import {
  forgetLinkToken,
  keepLinkToken,
  linkToken,
} from '#/lib/auth/link-tokens'
import { describeUserAgent } from '#/lib/user-agent'

type Loaded = { preview: SignInAlertPreview } | { problem: string }

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/**
 * "This wasn't me", from a new-sign-in email: shows the sign-in, then signs
 * that device out with a button (mail scanners open links on their own).
 * No sign-in needed: the person may have no other device to hand.
 */
export const Route = createFileRoute('/_auth/sign-in-alert')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.token) {
      keepLinkToken('sign-in-alert', search.token)
      throw redirect({ to: '/sign-in-alert', search: {}, replace: true })
    }
  },
  loader: async (): Promise<Loaded> => {
    const token = linkToken('sign-in-alert')
    if (!token) return { problem: 'Open the link from your email again.' }
    try {
      return { preview: await authApi.previewSignInAlert(token) }
    } catch (err) {
      return {
        problem:
          err instanceof ApiError
            ? err.message
            : 'This link could not be loaded.',
      }
    }
  },
  component: SignInAlertPage,
})

function SignInAlertPage() {
  const loaded = Route.useLoaderData()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (done) {
    return (
      <FieldGroup>
        <AuthHeading title="That device is signed out">
          Now change your password, so whoever signed in can't do it again.
          Changing it also signs out every other device.
        </AuthHeading>
        <Link to="/forgot-password" className={buttonVariants()}>
          Change your password
        </Link>
      </FieldGroup>
    )
  }

  if ('problem' in loaded) {
    return (
      <FieldGroup>
        <AuthHeading title="Link unavailable">{loaded.problem}</AuthHeading>
        <FieldDescription className="text-center">
          <Link to="/" className="underline underline-offset-4">
            Go home
          </Link>
        </FieldDescription>
      </FieldGroup>
    )
  }

  const { preview } = loaded
  const device = describeUserAgent(preview.user_agent)
  const Icon = device.mobile ? SmartphoneIcon : MonitorIcon

  async function report() {
    const token = linkToken('sign-in-alert')
    if (!token) return
    setPending(true)
    setError(null)
    try {
      await authApi.reportSignInAlert(token)
      forgetLinkToken('sign-in-alert')
      setDone(true)
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
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        void report()
      }}
    >
      <FieldGroup>
        <AuthHeading title="Not you?">
          {preview.session_active
            ? 'Sign this device out of your account.'
            : 'This device is already signed out.'}
        </AuthHeading>
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 text-sm">
            <div className="font-medium">{device.label}</div>
            <div className="text-xs text-muted-foreground">
              {[
                preview.ip,
                `Signed in ${dateTime.format(new Date(preview.signed_in_at))}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        </div>
        <FormError message={error} />
        <SubmitButton pending={pending}>
          {preview.session_active
            ? 'Sign out that device'
            : "Report it: it wasn't me"}
        </SubmitButton>
      </FieldGroup>
    </form>
  )
}
