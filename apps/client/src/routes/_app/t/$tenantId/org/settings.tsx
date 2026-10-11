import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'

import { pageNeeds } from '#/components/app/page-guard'
import { PageHeader } from '#/components/people/people-parts'
import { BrandingTab } from '#/components/settings/branding-tab'
import { EmailTab } from '#/components/settings/email-tab'
import { GeneralTab } from '#/components/settings/general-tab'
import { SecurityTab } from '#/components/settings/security-tab'
import { SsoTab } from '#/components/settings/sso-tab'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { settingsApi } from '#/lib/api/settings'

const TABS = ['general', 'branding', 'email', 'security', 'sso'] as const
type SettingsTab = (typeof TABS)[number]

export const Route = createFileRoute('/_app/t/$tenantId/org/settings')({
  ...pageNeeds('org.settings.manage', 'Settings', 'organization'),
  // The tab is in the URL, so a link (the email warning) can open one.
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } => ({
    tab: TABS.includes(search.tab as SettingsTab)
      ? (search.tab as SettingsTab)
      : undefined,
  }),
  loader: async () => {
    const [general, branding, email, security, sso] = await Promise.all([
      settingsApi.general(),
      settingsApi.branding(),
      settingsApi.email(),
      settingsApi.security(),
      settingsApi.sso(),
    ])
    return { general, branding, email, security, sso }
  },
  component: SettingsPage,
})

function SettingsPage() {
  const { general, branding, email, security, sso } = Route.useLoaderData()
  const { tab = 'general' } = Route.useSearch()
  const { tenant } = Route.useRouteContext()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const reload = () => router.invalidate()

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Settings"
        description="Your organization's name, how the product looks, whether email is working, sign-in security and single sign-on."
      />
      <Tabs
        value={tab}
        onValueChange={(next: SettingsTab) =>
          void navigate({
            search: { tab: next === 'general' ? undefined : next },
            replace: true,
          })
        }
        className="gap-6"
      >
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="branding">Branding</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="sso">Single sign-on</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <GeneralTab general={general} tenantId={tenant.id} onSaved={reload} />
        </TabsContent>
        <TabsContent value="branding">
          <BrandingTab branding={branding} />
        </TabsContent>
        <TabsContent value="email">
          <EmailTab email={email} onChanged={reload} />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab
            security={security}
            tenantId={tenant.id}
            onSaved={reload}
          />
        </TabsContent>
        <TabsContent value="sso">
          <SsoTab
            sso={sso}
            returnTo={`/t/${tenant.id}/org/settings?tab=sso`}
            onChanged={reload}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
