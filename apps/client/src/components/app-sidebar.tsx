import {
  Building2Icon,
  ContactIcon,
  FolderKanbanIcon,
  HistoryIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserCogIcon,
} from 'lucide-react'

import { BrandIcon, BrandMark } from '#/components/app/brand-mark'
import type { NavItem } from '#/components/nav-main'
import { NavMain } from '#/components/nav-main'
import { NavUser } from '#/components/nav-user'
import { TenantSwitcher } from '#/components/tenant-switcher'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from '#/components/ui/sidebar'
import type { Me } from '#/lib/api/auth'

/** Each item appears only with its permission. The server enforces it again. */
const NAV: (NavItem & { permission: string | null })[] = [
  {
    title: 'Dashboard',
    to: '/t/$tenantId',
    icon: <LayoutDashboardIcon />,
    permission: null,
  },
  {
    title: 'Projects',
    to: '/t/$tenantId/projects',
    icon: <FolderKanbanIcon />,
    permission: 'projects.view',
  },
]

const MANAGE: (NavItem & { permission: string })[] = [
  {
    title: 'People',
    to: '/t/$tenantId/people',
    icon: <UserCogIcon />,
    permission: 'tenant.users.view',
  },
]

/** Org-wide pages: shown to people whose org role includes the permission. */
const ORGANIZATION: (NavItem & { permission: string })[] = [
  {
    title: 'Directory',
    to: '/t/$tenantId/org/people',
    icon: <ContactIcon />,
    permission: 'org.users.manage',
  },
  {
    title: 'Tenants',
    to: '/t/$tenantId/org/tenants',
    icon: <Building2Icon />,
    permission: 'org.tenants.manage',
  },
  {
    title: 'Admins',
    to: '/t/$tenantId/org/admins',
    icon: <ShieldCheckIcon />,
    permission: 'org.users.manage',
  },
  {
    title: 'Roles',
    to: '/t/$tenantId/org/roles',
    icon: <KeyRoundIcon />,
    permission: 'org.roles.manage',
  },
  {
    title: 'Audit log',
    to: '/t/$tenantId/org/audit',
    icon: <HistoryIcon />,
    permission: 'org.audit.view',
  },
  {
    title: 'Settings',
    to: '/t/$tenantId/org/settings',
    icon: <SettingsIcon />,
    permission: 'org.settings.manage',
  },
]

export function AppSidebar({
  me,
  tenant,
  permissions,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  me: Me
  tenant: Me['tenants'][number]
  permissions: Set<string>
}) {
  const items = NAV.filter(
    (item) => item.permission === null || permissions.has(item.permission),
  )
  const manage = MANAGE.filter((item) => permissions.has(item.permission))
  const organization = ORGANIZATION.filter((item) =>
    permissions.has(item.permission),
  )
  return (
    <Sidebar collapsible="icon" variant="inset" expandOnHover {...props}>
      <SidebarHeader>
        {/* The product, as branded: the icon alone while the rail is collapsed. */}
        <div className="flex h-8 items-center px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <BrandIcon className="hidden size-6 group-data-[collapsible=icon]:flex" />
          <BrandMark className="group-data-[collapsible=icon]:hidden" />
        </div>
        <TenantSwitcher
          tenants={me.tenants}
          current={tenant}
          orgRoleName={me.org_role?.name ?? null}
          canCreate={me.org_permissions.includes('org.tenants.manage')}
        />
      </SidebarHeader>
      <SidebarContent>
        <NavMain label="App" tenantId={tenant.id} items={items} />
        {manage.length > 0 && (
          <NavMain label="Manage" tenantId={tenant.id} items={manage} />
        )}
        {organization.length > 0 && (
          <NavMain
            label="Organization"
            tenantId={tenant.id}
            items={organization}
          />
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={{ name: me.user.name, email: me.user.email }}
          tenantId={tenant.id}
        />
      </SidebarFooter>
    </Sidebar>
  )
}
