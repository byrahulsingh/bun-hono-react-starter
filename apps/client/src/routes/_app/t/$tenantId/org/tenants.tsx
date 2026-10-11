import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { CreateTenantDialog } from '#/components/app/create-tenant-dialog'
import { pageNeeds } from '#/components/app/page-guard'
import { MainTag } from '#/components/tenant-switcher'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { ConfirmDialog } from '#/components/people/people-dialogs'
import {
  PageHeader,
  RowActions,
  Section,
  formatDate,
} from '#/components/people/people-parts'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { toast } from '#/components/ui/toast'
import type { TenantSummary } from '#/lib/api/org'
import { tenantsApi } from '#/lib/api/org'
import { name } from '#/lib/auth/forms'
import { reloadMe } from '#/lib/auth/session'
import { formValues, useFormAction } from '#/lib/use-form-action'

export const Route = createFileRoute('/_app/t/$tenantId/org/tenants')({
  ...pageNeeds('org.tenants.manage', 'Tenants', 'organization'),
  loader: async () => ({ tenants: await tenantsApi.list() }),
  component: TenantsPage,
})

function TenantsPage() {
  const { tenants } = Route.useLoaderData()
  const { tenant: current } = Route.useRouteContext()
  const router = useRouter()
  const navigate = useNavigate()

  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<TenantSummary | null>(null)
  const [archiving, setArchiving] = useState<TenantSummary | null>(null)
  const [restoring, setRestoring] = useState<TenantSummary | null>(null)

  // Names and the switcher come from /me: reload it after every change.
  async function refresh() {
    await reloadMe()
    await router.invalidate()
  }

  return (
    <div className="flex flex-col gap-8 p-4 md:p-6">
      <PageHeader
        title="Tenants"
        description="Separate workspaces, each with its own data and people."
        action={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon aria-hidden="true" />
            Add tenant
          </Button>
        }
      />

      <Section
        title="All tenants"
        description="Archived tenants are read-only and hidden from the switcher until restored. Nothing is deleted."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Members</TableHead>
              <TableHead className="hidden sm:table-cell">Created</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((t) => (
              <TableRow
                key={t.id}
                className={
                  t.status === 'archived' ? 'text-muted-foreground' : ''
                }
              >
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    {t.status === 'active' ? (
                      <Link
                        to="/t/$tenantId"
                        params={{ tenantId: t.id }}
                        className="font-medium hover:underline"
                      >
                        {t.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{t.name}</span>
                    )}
                    {t.is_main && <MainTag />}
                    {t.id === current.id && (
                      <Badge variant="secondary">Current</Badge>
                    )}
                    {t.status === 'archived' && (
                      <Badge variant="outline">Archived</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {t.member_count}
                  <span className="sr-only"> members</span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {formatDate(t.created_at)}
                </TableCell>
                <TableCell>
                  <RowActions
                    label={`Actions for ${t.name}`}
                    actions={[
                      { label: 'Rename', onSelect: () => setRenaming(t) },
                      // The main tenant is the organization's own: never archived.
                      ...(t.is_main
                        ? []
                        : [
                            t.status === 'active'
                              ? {
                                  label: 'Archive',
                                  onSelect: () => setArchiving(t),
                                  destructive: true,
                                }
                              : {
                                  label: 'Restore',
                                  onSelect: () => setRestoring(t),
                                },
                          ]),
                    ]}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <CreateTenantDialog open={creating} onOpenChange={setCreating} />
      <RenameDialog
        tenant={renaming}
        onOpenChange={(open) => !open && setRenaming(null)}
        onDone={() => void refresh()}
      />
      <ConfirmDialog
        open={archiving !== null}
        title={`Archive ${archiving?.name ?? ''}?`}
        description="It disappears from everyone's tenant switcher and becomes read-only. Its data and people are kept, and you can restore it here at any time."
        confirmLabel="Archive"
        onOpenChange={(open) => !open && setArchiving(null)}
        run={() => tenantsApi.archive(archiving?.id ?? '')}
        done={`${archiving?.name ?? 'Tenant'} archived`}
        onDone={() => {
          // Archiving the tenant you are in: go to another one.
          if (archiving?.id === current.id)
            void reloadMe().then(() => navigate({ to: '/', replace: true }))
          else void refresh()
        }}
      />
      <ConfirmDialog
        open={restoring !== null}
        title={`Restore ${restoring?.name ?? ''}?`}
        description="It comes back in the tenant switcher, and everyone's access works as before."
        confirmLabel="Restore"
        destructive={false}
        onOpenChange={(open) => !open && setRestoring(null)}
        run={() => tenantsApi.restore(restoring?.id ?? '')}
        done={`${restoring?.name ?? 'Tenant'} restored`}
        onDone={() => void refresh()}
      />
    </div>
  )
}

const renameSchema = z.object({ name })

function RenameDialog({
  tenant,
  onOpenChange,
  onDone,
}: {
  tenant: TenantSummary | null
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  return (
    <Dialog open={tenant !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {tenant && (
          <RenameForm
            tenant={tenant}
            onDone={() => {
              onOpenChange(false)
              onDone()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({
  tenant,
  onDone,
}: {
  tenant: TenantSummary
  onDone: () => void
}) {
  const form = useFormAction(renameSchema, async (values) => {
    await tenantsApi.rename(tenant.id, values.name)
    toast.add({ title: `Renamed to ${values.name}`, type: 'success' })
    onDone()
  })
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onInput={() => form.clearField('name')}
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename tenant</DialogTitle>
      </DialogHeader>
      <FormError message={form.error} />
      <TextField
        name="name"
        label="Name"
        autoComplete="off"
        autoFocus
        defaultValue={tenant.name}
        error={form.fields.name}
      />
      <DialogFooter>
        <SubmitButton pending={form.pending}>Save</SubmitButton>
      </DialogFooter>
    </form>
  )
}
