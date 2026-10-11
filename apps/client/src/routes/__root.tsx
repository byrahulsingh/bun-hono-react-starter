import {
  Link,
  Outlet,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { Suspense, lazy } from 'react'

import {
  FullScreenLoader,
  InsecureOrigin,
  ServerUnavailable,
} from '#/components/status-screens'
import { Button, buttonVariants } from '#/components/ui/button'
import { Toaster } from '#/components/ui/toast'
import { TooltipProvider } from '#/components/ui/tooltip'
import { ApiError } from '#/lib/api/api'
import { retryStart, startAuth } from '#/lib/auth/session'
import { useAuthStore } from '#/lib/auth/store'
import { loadBranding } from '#/lib/branding'
import { loadPrefs } from '#/lib/prefs'

import '../styles.css'

/** What every route can reach. No tokens, no user data: the store holds that. */
export interface RouterContext {
  auth: { ready: () => Promise<void> }
}

// Devtools only in development: the production bundle does not even contain them.
const Devtools = import.meta.env.DEV
  ? lazy(async () => {
      const [{ TanStackDevtools }, { TanStackRouterDevtoolsPanel }] =
        await Promise.all([
          import('@tanstack/react-devtools'),
          import('@tanstack/react-router-devtools'),
        ])
      return {
        default: () => (
          <TanStackDevtools
            config={{ position: 'bottom-right' }}
            plugins={[
              {
                name: 'TanStack Router',
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        ),
      }
    })
  : null

export const Route = createRootRouteWithContext<RouterContext>()({
  // No route renders before the stored session has been checked. Preferences
  // and branding load alongside (never failing, never slow), so the first
  // render already knows them.
  beforeLoad: async () => {
    await Promise.all([startAuth(), loadPrefs(), loadBranding()])
  },
  component: RootComponent,
  pendingComponent: () => <FullScreenLoader />,
  errorComponent: RootError,
  notFoundComponent: NotFound,
})

function RootComponent() {
  const status = useAuthStore((s) => s.status)
  const problem = useAuthStore((s) => s.problem)

  return (
    <TooltipProvider>
      <Toaster>
        {status === 'loading' ? (
          <FullScreenLoader />
        ) : status === 'unavailable' ? (
          <ServerUnavailable
            problem={problem}
            onRetry={() => void retryStart()}
          />
        ) : status === 'unsupported' ? (
          <InsecureOrigin />
        ) : (
          <Outlet />
        )}
        {Devtools && (
          <Suspense>
            <Devtools />
          </Suspense>
        )}
      </Toaster>
    </TooltipProvider>
  )
}

/** Never shows a stack trace; the request id is what support needs. */
function RootError({ error, reset }: { error: unknown; reset: () => void }) {
  const requestId = error instanceof ApiError ? error.requestId : undefined
  if (import.meta.env.DEV) console.error(error)
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          {error instanceof ApiError
            ? error.message
            : 'An unexpected error occurred.'}
          {requestId && (
            <span className="mt-2 block font-mono text-xs">
              Reference: {requestId}
            </span>
          )}
        </p>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  )
}

function NotFound() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This page does not exist, or you don't have access to it.
        </p>
        <Link to="/" className={buttonVariants()}>
          Go home
        </Link>
      </div>
    </div>
  )
}
