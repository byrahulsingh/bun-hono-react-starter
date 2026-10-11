import { createFileRoute } from '@tanstack/react-router'

import { GettingStarted } from '#/components/app/getting-started'
import { Skeleton } from '#/components/ui/skeleton'
import { settingsApi } from '#/lib/api/settings'
import { useMe } from '#/lib/auth/store'

export const Route = createFileRoute('/_app/t/$tenantId/')({
  staticData: { title: 'Dashboard' },
  // The checklist is for people who can act on it; a failure to load it
  // must never cost anyone their dashboard.
  loader: async ({ context }) => ({
    onboarding: context.permissions.has('org.settings.manage')
      ? await settingsApi.onboarding().catch(() => null)
      : null,
  }),
  component: Dashboard,
})

function Dashboard() {
  const me = useMe()
  const { tenant } = Route.useRouteContext()
  const { onboarding } = Route.useLoaderData()
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div>
        <h1 className="text-2xl font-semibold">
          Welcome, {me.user.name.split(' ')[0]}
        </h1>
        <p className="text-sm text-muted-foreground">
          {tenant.name} — your product's overview goes here.
        </p>
      </div>
      {onboarding && (
        <GettingStarted onboarding={onboarding} tenantId={tenant.id} />
      )}
      <div className="grid auto-rows-min gap-4 md:grid-cols-3">
        <Skeleton className="aspect-video rounded-xl" />
        <Skeleton className="aspect-video rounded-xl" />
        <Skeleton className="aspect-video rounded-xl" />
      </div>
      <Skeleton className="min-h-64 flex-1 rounded-xl" />
    </div>
  )
}
