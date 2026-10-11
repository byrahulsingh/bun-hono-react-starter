import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'

import { useState } from 'react'

import { LoginForm } from '#/components/auth/login-form'
import { TwoFactorSignIn } from '#/components/auth/two-factor'
import { FieldDescription } from '#/components/ui/field'
import { authApi, setupApi } from '#/lib/api/auth'
import { safeRedirect } from '#/lib/auth/redirect'
import type { TwoFactorChallenge } from '#/lib/auth/session'
import { useAuthStore } from '#/lib/auth/store'

export const Route = createFileRoute('/_auth/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (useAuthStore.getState().status === 'signed-in')
      throw redirect({ href: safeRedirect(search.redirect) })
  },
  // Hints only (a fresh install, single sign-on offered); never block the form.
  loader: async () => {
    const [setup, sso] = await Promise.all([
      setupApi.status().catch(() => ({ needs_setup: false })),
      authApi.ssoAvailable().catch(() => ({ available: false })),
    ])
    return { needs_setup: setup.needs_setup, sso_available: sso.available }
  },
  component: LoginPage,
})

function LoginPage() {
  const { redirect: target } = Route.useSearch()
  const { needs_setup, sso_available } = Route.useLoaderData()
  const sessionEnded = useAuthStore((s) => s.signedOutBy === 'session')
  const navigate = useNavigate()
  const [pending, setPending] = useState<{
    challenge: TwoFactorChallenge
    email: string
  } | null>(null)
  const done = () =>
    void navigate({ href: safeRedirect(target), replace: true })

  if (pending) {
    return (
      <TwoFactorSignIn
        challenge={pending.challenge}
        account={pending.email}
        onSignedIn={done}
        onRestart={() => setPending(null)}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {needs_setup && (
        <FieldDescription className="rounded-md border p-3 text-center">
          This install is not set up yet. Open the setup link printed in the
          server log.
        </FieldDescription>
      )}
      {sessionEnded && (
        <FieldDescription className="rounded-md border p-3 text-center">
          Your session ended. Sign in again to continue.
        </FieldDescription>
      )}
      <LoginForm
        ssoAvailable={sso_available}
        redirect={target}
        onSignedIn={done}
        onTwoFactor={(challenge, email) => setPending({ challenge, email })}
      />
    </div>
  )
}
