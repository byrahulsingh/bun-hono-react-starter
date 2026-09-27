import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { basePath } from '#/lib/app-config'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    // Links and matching are relative to where the host mounted the app.
    basepath: basePath || '/',
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
