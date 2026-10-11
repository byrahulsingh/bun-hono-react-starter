import { Combobox } from '@base-ui/react'
import { useNavigate } from '@tanstack/react-router'
import { CheckIcon, ChevronDownIcon, PlusIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { CreateTenantDialog } from '#/components/app/create-tenant-dialog'
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxList,
  ComboboxSeparator,
} from '#/components/ui/combobox'
import { useSidebar } from '#/components/ui/sidebar'
import type { Me } from '#/lib/api/auth'

type Tenant = Me['tenants'][number]

function TenantBadge({ name, className }: { name: string; className: string }) {
  return (
    <div className={className} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </div>
  )
}

/** Marks the organization's own tenant among client tenants. */
export function MainTag({ className }: { className?: string }) {
  return (
    <span
      className={`rounded-sm border px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase ${className ?? ''}`}
      title="Your organization's own tenant, created at setup"
    >
      Main
    </span>
  )
}

/**
 * The tenant you are in, at the top of the sidebar. Opens a list below it;
 * typing filters it (an agency can have many clients). Lists only tenants
 * from /me; switching changes the tenant id in the URL.
 */
export function TenantSwitcher({
  tenants,
  current,
  orgRoleName,
  canCreate,
}: {
  tenants: Tenant[]
  current: Tenant
  /** Shown for tenants reached through the organization role (no role of their own there). */
  orgRoleName: string | null
  /** org.tenants.manage: offers "Add tenant". */
  canCreate: boolean
}) {
  const { holdPeek } = useSidebar()
  const navigate = useNavigate()
  const anchor = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)

  const setOpenState = (next: boolean) => {
    setOpen(next)
    // While the list is open the rail stays expanded under it.
    holdPeek(next)
    if (!next) setQuery('')
  }

  return (
    <>
      <Combobox.Root<Tenant>
        items={tenants}
        // Nothing "selected": the current tenant is shown as the box's text
        // and checked in the list; picking one goes there.
        value={null}
        onValueChange={(tenant) => {
          if (!tenant) return
          setOpenState(false)
          if (tenant.id !== current.id)
            void navigate({
              to: '/t/$tenantId',
              params: { tenantId: tenant.id },
            })
        }}
        inputValue={query}
        onInputValueChange={setQuery}
        open={open}
        onOpenChange={setOpenState}
        itemToStringLabel={(tenant) => tenant.name}
        // The whole typed text, anywhere in the name ("acme cl" finds "Acme Clients", not every "Clients").
        filter={(tenant, query) =>
          tenant.name
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())
        }
        isItemEqualToValue={(a, b) => a.id === b.id}
      >
        <div
          ref={anchor}
          data-sidebar="tenant-switcher"
          title={current.name}
          className="flex h-11 items-center gap-2 rounded-lg border border-sidebar-border bg-background px-1.5 shadow-xs transition-[width,height,padding] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:shadow-none"
        >
          {/* For the mouse, and all there is of the box on the collapsed rail: opens
              the list (the rail expands under it). Keyboard users have the input. */}
          <button
            type="button"
            tabIndex={-1}
            aria-label="Open tenant list"
            data-slot="tenant-badge"
            className="shrink-0 rounded-md"
            onClick={() => {
              setOpenState(true)
              requestAnimationFrame(() => input.current?.focus())
            }}
          >
            <TenantBadge
              name={current.name}
              className="flex size-8 items-center justify-center rounded-md bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground"
            />
          </button>
          <Combobox.Input
            ref={input}
            aria-label="Switch tenant"
            // The current tenant's name, in full colour until the list opens and typing filters it.
            placeholder={current.name}
            className="min-w-0 flex-1 truncate bg-transparent text-sm font-medium outline-none placeholder:text-foreground data-popup-open:placeholder:text-muted-foreground group-data-[collapsible=icon]:hidden"
          />
          <Combobox.Trigger
            aria-label="Show tenants"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted group-data-[collapsible=icon]:hidden"
          >
            <ChevronDownIcon
              className="size-4 transition-transform in-data-popup-open:rotate-180"
              aria-hidden="true"
            />
          </Combobox.Trigger>
        </div>

        <ComboboxContent anchor={anchor} className="min-w-(--anchor-width)">
          <ComboboxEmpty>No tenant matches</ComboboxEmpty>
          <ComboboxList>
            {(tenant: Tenant) => (
              <Combobox.Item
                key={tenant.id}
                value={tenant}
                className="flex w-full cursor-default items-center gap-2 rounded-md p-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
              >
                <TenantBadge
                  name={tenant.name}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md border text-xs font-medium"
                />
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`truncate ${tenant.id === current.id ? 'font-medium text-primary' : ''}`}
                    >
                      {tenant.name}
                    </span>
                    {tenant.is_main && <MainTag />}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {tenant.role?.name ?? orgRoleName ?? ''}
                  </span>
                </span>
                {tenant.id === current.id && (
                  <CheckIcon
                    className="size-4 shrink-0 text-primary"
                    aria-label="Current"
                  />
                )}
              </Combobox.Item>
            )}
          </ComboboxList>
          {canCreate && (
            <>
              <ComboboxSeparator />
              <div className="p-1 pt-0">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md p-1.5 text-sm font-medium text-primary outline-hidden hover:bg-accent focus-visible:bg-accent"
                  onClick={() => {
                    setOpenState(false)
                    setCreating(true)
                  }}
                >
                  <span className="flex size-7 items-center justify-center rounded-md border border-dashed">
                    <PlusIcon className="size-4" aria-hidden="true" />
                  </span>
                  Add tenant
                </button>
              </div>
            </>
          )}
        </ComboboxContent>
      </Combobox.Root>
      <CreateTenantDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}
