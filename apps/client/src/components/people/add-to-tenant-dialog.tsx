import { useState } from 'react'
import { z } from 'zod'

import { FormError, SubmitButton } from '#/components/auth/form-parts'
import { RoleField } from '#/components/people/people-dialogs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '#/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Skeleton } from '#/components/ui/skeleton'
import { toast } from '#/components/ui/toast'
import type { OrgPerson } from '#/lib/api/org'
import { orgApi } from '#/lib/api/org'
import type { AssignableRole } from '#/lib/api/people'
import { peopleApi } from '#/lib/api/people'
import { formValues, useFormAction } from '#/lib/use-form-action'

import { errorMessage } from './people-parts'

// The role picker only exists once a tenant is chosen, so a missing field
// gets the same friendly message as an empty one.
const schema = z.object({
  tenant_id: z.string({ error: 'Choose a tenant' }).min(1, 'Choose a tenant'),
  role_id: z.string({ error: 'Choose a role' }).min(1, 'Choose a role'),
})

/** Gives someone with an account a membership right away; they get an email. */
export function AddToTenantDialog({
  person,
  tenants,
  onOpenChange,
  onDone,
}: {
  /** null = closed. */
  person: OrgPerson | null
  /** Active tenants; the ones they are already in are left out. */
  tenants: { id: string; name: string }[]
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  return (
    <Dialog open={person !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {person && (
          <AddForm
            person={person}
            tenants={tenants.filter(
              (t) => !person.tenants.some((m) => m.id === t.id),
            )}
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

function AddForm({
  person,
  tenants,
  onDone,
}: {
  person: OrgPerson
  tenants: { id: string; name: string }[]
  onDone: () => void
}) {
  const [tenantId, setTenantId] = useState<string | null>(null)
  // Roles depend on the tenant (and on what you may hand out there).
  const [roles, setRoles] = useState<AssignableRole[] | 'loading' | null>(null)
  const form = useFormAction(schema, async (values) => {
    await orgApi.addToTenant(person.user_id, values)
    const tenant = tenants.find((t) => t.id === values.tenant_id)
    toast.add({
      title: `${person.name} added to ${tenant?.name ?? 'the tenant'}`,
      description: 'They were told by email.',
      type: 'success',
    })
    onDone()
  })

  async function pickTenant(id: string) {
    setTenantId(id)
    form.clearField('tenant_id')
    setRoles('loading')
    try {
      setRoles(await peopleApi.roles(id))
    } catch (err) {
      setRoles(null)
      toast.add({ title: errorMessage(err), type: 'error' })
    }
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <DialogHeader>
        <DialogTitle>Add {person.name} to a tenant</DialogTitle>
        <DialogDescription>
          No invitation needed: they already have an account. The tenant appears
          in their switcher, and they get an email.
        </DialogDescription>
      </DialogHeader>
      <FormError message={form.error} />
      {tenants.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          They are already in every active tenant.
        </p>
      ) : (
        <>
          <Field data-invalid={form.fields.tenant_id ? true : undefined}>
            <FieldLabel htmlFor="tenant_id">Tenant</FieldLabel>
            <Select
              name="tenant_id"
              value={tenantId}
              items={Object.fromEntries(tenants.map((t) => [t.id, t.name]))}
              onValueChange={(value) => value && void pickTenant(value)}
            >
              <SelectTrigger id="tenant_id" className="w-full">
                <SelectValue placeholder="Choose a tenant" />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {tenants.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.fields.tenant_id && (
              <FieldError>{form.fields.tenant_id}</FieldError>
            )}
          </Field>
          {roles === 'loading' ? (
            <Skeleton className="h-14 w-full" />
          ) : roles ? (
            <RoleField
              key={tenantId}
              roles={roles}
              error={form.fields.role_id}
              onChange={() => form.clearField('role_id')}
            />
          ) : null}
        </>
      )}
      <DialogFooter>
        <SubmitButton pending={form.pending}>Add to tenant</SubmitButton>
      </DialogFooter>
    </form>
  )
}
