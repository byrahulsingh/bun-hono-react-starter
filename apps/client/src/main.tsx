import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'

import { useAuthStore } from '#/lib/auth/store'

import { getRouter } from './router'

// The router and its type registration live in router.tsx, so there is one
// source of truth for router options.
const router = getRouter()

// Signing in or out (here or in another tab) re-runs the route guards, so a
// signed-out tab leaves protected pages at once.
useAuthStore.subscribe((state, previous) => {
  if (state.status !== previous.status) void router.invalidate()
})

const rootElement = document.getElementById('app')!

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(<RouterProvider router={router} />)
}
