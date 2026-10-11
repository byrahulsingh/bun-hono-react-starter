import { Link } from '@tanstack/react-router'

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '#/components/ui/sidebar'

export interface NavItem {
  title: string
  to:
    | '/t/$tenantId'
    | '/t/$tenantId/projects'
    | '/t/$tenantId/people'
    | '/t/$tenantId/org/tenants'
    | '/t/$tenantId/org/admins'
    | '/t/$tenantId/org/people'
    | '/t/$tenantId/org/roles'
    | '/t/$tenantId/org/audit'
    | '/t/$tenantId/org/settings'
  icon: React.ReactNode
}

export function NavMain({
  label,
  tenantId,
  items,
}: {
  label: string
  tenantId: string
  items: NavItem[]
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.to}>
            <SidebarMenuButton
              render={
                <Link
                  to={item.to}
                  params={{ tenantId }}
                  activeOptions={{ exact: item.to === '/t/$tenantId' }}
                  activeProps={{ 'data-active': true }}
                />
              }
            >
              {item.icon}
              <span>{item.title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
