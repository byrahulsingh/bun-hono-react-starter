import { useNavigate } from '@tanstack/react-router'
import { z } from 'zod'

import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { toast } from '#/components/ui/toast'
import { tenantsApi } from '#/lib/api/org'
import { name } from '#/lib/auth/forms'
import { reloadMe } from '#/lib/auth/session'
import { formValues, useFormAction } from '#/lib/use-form-action'

const createTenantSchema = z.object({ name })

/** Creates a tenant, then opens it. Only offered with org.tenants.manage. */
export function CreateTenantDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Inside the popup, so each opening starts with an empty form. */}
        <CreateTenantForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function CreateTenantForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate()
  const form = useFormAction(createTenantSchema, async (values) => {
    const tenant = await tenantsApi.create(values.name)
    // /me lists the tenants this person can open: reload it so the new one is there.
    await reloadMe()
    onDone()
    toast.add({ title: `${tenant.name} created`, type: 'success' })
    await navigate({ to: '/t/$tenantId', params: { tenantId: tenant.id } })
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
        <DialogTitle>Add tenant</DialogTitle>
        <DialogDescription>
          A separate workspace with its own data and people. Owners
          and admins can open it; invite anyone else from its People page.
        </DialogDescription>
      </DialogHeader>
      <FormError message={form.error} />
      <TextField
        name="name"
        label="Name"
        placeholder="e.g. a client or a team"
        autoComplete="off"
        autoFocus
        error={form.fields.name}
      />
      <DialogFooter>
        <SubmitButton pending={form.pending}>Create tenant</SubmitButton>
      </DialogFooter>
    </form>
  )
}
