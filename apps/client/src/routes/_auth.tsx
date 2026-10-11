import { Outlet, createFileRoute } from '@tanstack/react-router'

import { AuthShell } from '#/components/auth/auth-shell'

/** Layout for the signed-out pages (no URL segment of its own). */
export const Route = createFileRoute('/_auth')({
  component: () => (
    <AuthShell>
      <Outlet />
    </AuthShell>
  ),
})
