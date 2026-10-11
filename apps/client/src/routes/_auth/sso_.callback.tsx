import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { Loader2Icon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { AuthHeading } from '#/components/auth/auth-shell'
import { FieldDescription, FieldGroup } from '#/components/ui/field'
import { ApiError } from '#/lib/api/api'
import type { SsoAnswer } from '#/lib/auth/sso-answer'
import {
  keepSsoAnswer,
  keepSsoTestResult,
  takeSsoAnswer,
} from '#/lib/auth/sso-answer'
import { safeRedirect } from '#/lib/auth/redirect'
import { finishSso } from '#/lib/auth/session'

type Answer = SsoAnswer

/**
 * Where the single sign-on provider sends the browser back. The code leaves
 * the address bar at once (kept in memory only, like link tokens), then goes
 * to the API from the device that started.
 */
export const Route = createFileRoute('/_auth/sso_/callback')({
  validateSearch: (search: Record<string, unknown>): Answer => {
    const text = (key: string) =>
      typeof search[key] === 'string' ? (search[key] as string) : undefined
    return {
      code: text('code'),
      state: text('state'),
      error: text('error'),
      error_description: text('error_description'),
    }
  },
  beforeLoad: ({ search }) => {
    if (search.code || search.state || search.error) {
      keepSsoAnswer(search)
      throw redirect({ to: '/sso/callback', search: {}, replace: true })
    }
  },
  component: SsoCallbackPage,
})

/** One finish per answer, even if the page renders twice (React's dev mode does). */
let finishing: Promise<string> | null = null

function finish(answer: Answer | null): Promise<string> {
  finishing ??= (async () => {
    if (!answer)
      throw new Error('Nothing to finish here. Start signing in again.')
    if (answer.error) {
      throw new Error(
        answer.error === 'access_denied'
          ? 'Signing in was cancelled at your provider.'
          : `Your provider could not sign you in (${answer.error_description ?? answer.error}).`,
      )
    }
    if (!answer.code || !answer.state)
      throw new Error(
        'The answer from your provider is incomplete. Start again.',
      )
    const done = await finishSso(answer.code, answer.state)
    if (done.purpose === 'test') {
      keepSsoTestResult(done.result)
      return safeRedirect(done.returnTo)
    }
    return safeRedirect(done.redirect)
  })().finally(() => {
    // Another answer (a new trip) gets a fresh attempt.
    setTimeout(() => {
      finishing = null
    }, 0)
  })
  return finishing
}

function SsoCallbackPage() {
  const navigate = useNavigate()
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    finish(takeSsoAnswer()).then(
      (to) => void navigate({ href: to, replace: true }),
      (err: unknown) =>
        setProblem(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : 'Something went wrong. Try again.',
        ),
    )
  }, [navigate])

  if (problem) {
    return (
      <FieldGroup>
        <AuthHeading title="Couldn't sign you in">{problem}</AuthHeading>
        <FieldDescription className="text-center">
          <Link to="/sso" className="underline underline-offset-4">
            Try again
          </Link>{' '}
          ·{' '}
          <Link to="/login" className="underline underline-offset-4">
            Sign in with a password
          </Link>
        </FieldDescription>
      </FieldGroup>
    )
  }

  return (
    <div
      className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      Finishing sign-in…
    </div>
  )
}
