import { createFileRoute, redirect } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { signOut } from '#/lib/auth/session'
import { useAuthStore } from '#/lib/auth/store'
import { usePrefs } from '#/lib/prefs'

/** `/` opens the last tenant used, or the first one this person can see. */
export const Route = createFileRoute('/_app/')({
  beforeLoad: () => {
    const tenants = useAuthStore.getState().me?.tenants ?? []
    const remembered = usePrefs.getState().person.lastTenant
    const target = tenants.find((t) => t.id === remembered) ?? tenants.at(0)
    if (target)
      throw redirect({
        to: '/t/$tenantId',
        params: { tenantId: target.id },
        replace: true,
      })
  },
  component: NoTenants,
})

function NoTenants() {
  const me = useAuthStore((s) => s.me)
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold">No workspace yet</h1>
        <p className="text-sm text-muted-foreground">
          You're signed in as {me?.user.email}, but you are not a member of any
          tenant. Ask an administrator to invite you to one.
        </p>
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  )
}
