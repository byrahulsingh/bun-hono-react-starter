import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

import { useAuthStore } from '#/lib/auth/store'

/**
 * Every signed-in page sits under this guard (no URL segment of its own).
 * The root route has already waited for the stored session to be checked.
 */
export const Route = createFileRoute('/_app')({
  beforeLoad: ({ location }) => {
    const { status, signedOutBy } = useAuthStore.getState()
    if (status !== 'signed-in') {
      // After choosing to sign out, start fresh: no way back to the previous
      // page (and its tenant id) for whoever signs in next on this browser.
      // Otherwise (session ended, or a link opened while signed out), offer it.
      throw redirect({
        to: '/login',
        search: signedOutBy === 'user' ? {} : { redirect: location.href },
        replace: true,
      })
    }
  },
  component: SignedIn,
})

/**
 * Nothing below renders once signed out. The redirect to /login follows a
 * moment later (main.tsx invalidates the router); until then the pages under
 * here would render once without a person and throw.
 */
function SignedIn() {
  const signedIn = useAuthStore((s) => s.me !== null)
  return signedIn ? <Outlet /> : null
}
