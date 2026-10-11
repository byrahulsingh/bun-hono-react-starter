import { createRouter as createTanStackRouter } from '@tanstack/react-router'

import { FullScreenLoader } from '#/components/status-screens'
import { basePath } from '#/lib/app-config'
import { startAuth } from '#/lib/auth/session'

import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    // Links and matching are relative to where the host mounted the app.
    basepath: basePath || '/',
    // Functions only: no tokens or user data travel in the router context,
    // which devtools can display.
    context: { auth: { ready: startAuth } },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    // A loader appears only if a route takes a moment, and then stays long
    // enough not to flicker.
    defaultPendingComponent: () => <FullScreenLoader />,
    defaultPendingMs: 150,
    defaultPendingMinMs: 300,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
  interface StaticDataRouteOption {
    /** Shown in the page header's breadcrumb. */
    title?: string
    /** Organization-wide pages show "Organization" instead of the tenant's name. */
    section?: 'organization'
  }
}
