import {
  Outlet,
  createFileRoute,
  notFound,
  useMatches,
} from '@tanstack/react-router'
import { useEffect } from 'react'

import { AppSidebar } from '#/components/app-sidebar'
import {
  AssistantPanel,
  AssistantToggle,
} from '#/components/layout/assistant-panel'
import { EmailWarning } from '#/components/app/email-warning'
import { ContentSkeleton, TenantNotFound } from '#/components/app/page-states'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '#/components/ui/breadcrumb'
import { Separator } from '#/components/ui/separator'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '#/components/ui/sidebar'
import { ApiError } from '#/lib/api/api'
import { tenantPermissions } from '#/lib/auth/session'
import { useAuthStore, useMe } from '#/lib/auth/store'
import { pageTitle, useBranding } from '#/lib/branding'
import { rememberTenant, setSidebarPinned, usePrefs } from '#/lib/prefs'

/**
 * Everything inside one tenant. Before anything renders: the tenant must be
 * one this person has (from /me), and their permissions in it are loaded.
 * Child pages receive them in their route context.
 */
export const Route = createFileRoute('/_app/t/$tenantId')({
  beforeLoad: async ({ params }) => {
    const tenant = useAuthStore
      .getState()
      .me?.tenants.find((t) => t.id === params.tenantId)
    if (!tenant) throw notFound()
    try {
      return { tenant, permissions: await tenantPermissions(tenant.id) }
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN')
      )
        throw notFound()
      throw err
    }
  },
  pendingComponent: ContentSkeleton,
  notFoundComponent: TenantNotFound,
  component: TenantLayout,
})

function TenantLayout() {
  const me = useMe()
  const { tenant, permissions } = Route.useRouteContext()
  const page = useMatches({
    select: (matches) => matches.at(-1)?.staticData,
  })

  const sidebarPinned = usePrefs((s) => s.device.sidebarPinned)

  useEffect(() => rememberTenant(tenant.id), [tenant.id])

  const productName = useBranding((s) => s.product_name)
  useEffect(() => {
    document.title = pageTitle(page?.title ?? 'Dashboard')
  }, [page?.title, productName])

  return (
    // Three columns, like a desktop app: the icon rail (expands on hover, or
    // pinned open), the page, and the assistant panel when it is open. On
    // wider screens the shell fills the window and only the page scrolls.
    <SidebarProvider
      open={sidebarPinned}
      onOpenChange={setSidebarPinned}
      style={{ '--assistant-width': '24rem' } as React.CSSProperties}
    >
      <AppSidebar me={me} tenant={tenant} permissions={permissions} />
      <div className="flex min-w-0 flex-1 md:h-svh md:py-2 md:pr-2">
        <SidebarInset className="min-w-0 md:overflow-hidden md:rounded-xl md:shadow-sm md:ring-1 md:ring-sidebar-border">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem className="hidden md:block">
                  {page?.section === 'organization'
                    ? 'Organization'
                    : tenant.name}
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>{page?.title ?? 'Dashboard'}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            {/* Right side of the bar: search (later) and the assistant. */}
            <div className="ml-auto flex items-center gap-1">
              <AssistantToggle />
            </div>
          </header>
          {me.org_permissions.includes('org.settings.manage') && (
            <EmailWarning tenantId={tenant.id} />
          )}
          <div className="flex flex-1 flex-col md:overflow-y-auto">
            <Outlet />
          </div>
        </SidebarInset>
        <AssistantPanel />
      </div>
    </SidebarProvider>
  )
}
