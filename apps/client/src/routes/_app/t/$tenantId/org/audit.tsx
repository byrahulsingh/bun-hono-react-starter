import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  HistoryIcon,
  Loader2Icon,
} from 'lucide-react'
import { useState } from 'react'

import { DateRangePicker } from '#/components/app/date-range-picker'
import { pageNeeds } from '#/components/app/page-guard'
import { PageHeader, errorMessage } from '#/components/people/people-parts'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { toast } from '#/components/ui/toast'
import type {
  AuditCategory,
  AuditEntry,
  AuditFilterOptions,
  AuditFilters,
  AuditPage,
} from '#/lib/api/audit'
import { auditApi } from '#/lib/api/audit'
import { describeEntry } from '#/lib/audit-format'
import { describeUserAgent } from '#/lib/user-agent'

/** Filters live in the URL: a filtered view can be shared, and Back works. */
interface AuditSearch {
  category?: AuditCategory
  tenant?: string
  actor?: string
  /** Calendar days (YYYY-MM-DD), in the viewer's time zone. */
  from?: string
  to?: string
}

const CATEGORIES: { value: AuditCategory; label: string }[] = [
  { value: 'security', label: 'Sign-in and security' },
  { value: 'people', label: 'People and access' },
  { value: 'roles', label: 'Roles' },
  { value: 'tenants', label: 'Tenants' },
  { value: 'account', label: 'Profiles and setup' },
  { value: 'settings', label: 'Organization settings' },
]

const DAY = /^\d{4}-\d{2}-\d{2}$/
const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

export const Route = createFileRoute('/_app/t/$tenantId/org/audit')({
  ...pageNeeds('org.audit.view', 'Audit log', 'organization'),
  validateSearch: (search: Record<string, unknown>): AuditSearch => ({
    category: CATEGORIES.some((c) => c.value === search.category)
      ? (search.category as AuditCategory)
      : undefined,
    tenant: text(search.tenant),
    actor: text(search.actor),
    from: DAY.test(String(search.from)) ? String(search.from) : undefined,
    to: DAY.test(String(search.to)) ? String(search.to) : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [page, options] = await Promise.all([
      auditApi.page(toFilters(deps)),
      auditApi.filters(),
    ])
    return { page, options }
  },
  component: AuditPage,
})

/** The URL's calendar days → the exact instants the API filters on. */
function toFilters(search: AuditSearch): AuditFilters {
  return {
    category: search.category,
    tenant: search.tenant,
    actor: search.actor,
    from: search.from
      ? new Date(`${search.from}T00:00:00`).toISOString()
      : undefined,
    to: search.to
      ? new Date(`${search.to}T23:59:59.999`).toISOString()
      : undefined,
  }
}

function AuditPage() {
  const { page, options } = Route.useLoaderData()
  const search = Route.useSearch()
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Audit log"
        description="Who did what, and when: sign-ins, access changes, roles and tenants. Entries can't be edited or deleted."
      />
      <FilterBar search={search} options={options} />
      {/* Remounts when the filters change, so "load more" starts over. */}
      <AuditList key={JSON.stringify(search)} first={page} search={search} />
    </div>
  )
}

// ─── Filters ─────────────────────────────────────────────────────

const ALL = 'all'

function FilterSelect({
  id,
  label,
  value,
  allLabel,
  items,
  onChange,
}: {
  id: string
  label: string
  value: string | undefined
  allLabel: string
  items: { value: string; label: string }[]
  onChange: (value: string | undefined) => void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select
        value={value ?? ALL}
        items={Object.fromEntries([
          [ALL, allLabel],
          ...items.map((i) => [i.value, i.label]),
        ])}
        onValueChange={(next) =>
          onChange(next && next !== ALL ? next : undefined)
        }
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function FilterBar({
  search,
  options,
}: {
  search: AuditSearch
  options: AuditFilterOptions
}) {
  const navigate = useNavigate({ from: Route.fullPath })
  const set = (patch: Partial<AuditSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }) })
  const filtered = Object.values(search).some(Boolean)

  return (
    <div className="grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
      <FilterSelect
        id="audit-category"
        label="Activity"
        value={search.category}
        allLabel="All activity"
        items={CATEGORIES}
        onChange={(category) =>
          set({ category: category as AuditCategory | undefined })
        }
      />
      <FilterSelect
        id="audit-tenant"
        label="Tenant"
        value={search.tenant}
        allLabel="All tenants"
        items={options.tenants.map((t) => ({
          value: t.id,
          label: t.status === 'archived' ? `${t.name} (archived)` : t.name,
        }))}
        onChange={(tenant) => set({ tenant })}
      />
      <FilterSelect
        id="audit-actor"
        label="Person"
        value={search.actor}
        allLabel="Everyone"
        items={options.people.map((p) => ({
          value: p.id,
          label: p.email ? `${p.name} (${p.email})` : p.name,
        }))}
        onChange={(actor) => set({ actor })}
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="audit-dates" className="text-xs text-muted-foreground">
          Date
        </Label>
        <DateRangePicker
          id="audit-dates"
          value={{ from: search.from, to: search.to }}
          onChange={({ from, to }) => set({ from, to })}
        />
      </div>
      <Button
        variant="ghost"
        disabled={!filtered}
        onClick={() => void navigate({ search: {} })}
      >
        Clear
      </Button>
    </div>
  )
}

// ─── Entries ─────────────────────────────────────────────────────

const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })
const day = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})
const full = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
})

function dayLabel(date: Date) {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return day.format(date)
}

function AuditList({
  first,
  search,
}: {
  first: AuditPage
  search: AuditSearch
}) {
  const [entries, setEntries] = useState(first.entries)
  const [refs, setRefs] = useState(first.refs)
  const [next, setNext] = useState(first.next)
  const [loading, setLoading] = useState(false)

  async function loadMore() {
    if (!next || loading) return
    setLoading(true)
    try {
      const page = await auditApi.page(toFilters(search), next)
      setEntries((current) => [...current, ...page.entries])
      setRefs((current) => ({
        users: { ...current.users, ...page.refs.users },
        tenants: { ...current.tenants, ...page.refs.tenants },
        roles: { ...current.roles, ...page.refs.roles },
        invitations: { ...current.invitations, ...page.refs.invitations },
      }))
      setNext(page.next)
    } catch (err) {
      toast.add({ title: errorMessage(err), type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        <HistoryIcon className="size-5" aria-hidden="true" />
        {Object.values(search).some(Boolean)
          ? 'Nothing matches these filters.'
          : 'No activity yet.'}
      </div>
    )
  }

  // Consecutive entries of the same day share a heading.
  const groups: { label: string; entries: AuditEntry[] }[] = []
  for (const entry of entries) {
    const label = dayLabel(new Date(entry.created_at))
    if (groups.at(-1)?.label === label) groups.at(-1)!.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.label} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            {group.label}
          </h2>
          <ul className="divide-y rounded-lg border">
            {group.entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} refs={refs} />
            ))}
          </ul>
        </section>
      ))}
      {next && (
        <Button
          variant="outline"
          className="self-center"
          disabled={loading}
          aria-busy={loading}
          onClick={() => void loadMore()}
        >
          {loading && (
            <Loader2Icon className="animate-spin" aria-hidden="true" />
          )}
          Load older entries
        </Button>
      )}
    </div>
  )
}

function AuditRow({
  entry,
  refs,
}: {
  entry: AuditEntry
  refs: AuditPage['refs']
}) {
  const [open, setOpen] = useState(false)
  const described = describeEntry(entry, refs)
  const tenant = entry.tenant_id ? refs.tenants[entry.tenant_id] : undefined
  const at = new Date(entry.created_at)
  const detailsId = `audit-${entry.id}`

  return (
    <li>
      <button
        type="button"
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((v) => !v)}
      >
        <time
          dateTime={entry.created_at}
          title={full.format(at)}
          className="w-14 shrink-0 pt-px text-xs text-muted-foreground tabular-nums"
        >
          {time.format(at)}
        </time>
        {described.warning && (
          <AlertTriangleIcon
            className="mt-0.5 size-4 shrink-0 text-destructive"
            aria-label="Security event"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="font-medium">{described.actor}</span>{' '}
          {described.text}
        </span>
        {tenant && (
          <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
            {tenant}
          </Badge>
        )}
        <ChevronRightIcon
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform data-[open=true]:rotate-90"
          data-open={open}
          aria-hidden="true"
        />
      </button>
      {open && <AuditDetails id={detailsId} entry={entry} refs={refs} />}
    </li>
  )
}

function AuditDetails({
  id,
  entry,
  refs,
}: {
  id: string
  entry: AuditEntry
  refs: AuditPage['refs']
}) {
  const actor = entry.actor_user_id
    ? refs.users[entry.actor_user_id]
    : undefined
  const rows: [string, React.ReactNode][] = [
    ['When', full.format(new Date(entry.created_at))],
    ['Action', <code key="a">{entry.action}</code>],
    [
      'By',
      actor ? `${actor.name}${actor.email ? ` (${actor.email})` : ''}` : '—',
    ],
    [
      'Tenant',
      entry.tenant_id
        ? (refs.tenants[entry.tenant_id] ?? entry.tenant_id)
        : 'Organization',
    ],
    ['IP address', entry.ip ?? '—'],
    [
      'Device',
      entry.user_agent ? describeUserAgent(entry.user_agent).label : '—',
    ],
    [
      'Request ID',
      entry.request_id ? <code key="r">{entry.request_id}</code> : '—',
    ],
  ]
  return (
    <div id={id} className="border-t bg-muted/30 px-3 py-3 text-sm sm:pl-20">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {entry.changes && Object.keys(entry.changes).length > 0 && (
        <pre className="mt-3 overflow-x-auto rounded-md border bg-background p-3 text-xs">
          {JSON.stringify(entry.changes, null, 2)}
        </pre>
      )}
    </div>
  )
}
