import { useBlocker } from '@tanstack/react-router'
import { InfoIcon, LockIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { z } from 'zod'

import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#/components/ui/alert-dialog'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Field, FieldError, FieldLabel } from '#/components/ui/field'
import { RadioGroup, RadioGroupItem } from '#/components/ui/radio-group'
import { Textarea } from '#/components/ui/textarea'
import type { RoleCatalog, RoleScope } from '#/lib/api/roles'
import { useFormAction } from '#/lib/use-form-action'

import { permissionsForScope, tick, untick } from './permission-rules'

export interface RoleDraft {
  name: string
  description: string
  scope: RoleScope
  permissions: string[]
}

const draftSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Required')
    .max(60, 'Use at most 60 characters'),
  description: z.string().trim().max(300, 'Use at most 300 characters'),
  scope: z.enum(['org', 'tenant']),
  permissions: z.array(z.string()).min(1, 'Choose at least one permission.'),
})

const sameSet = (a: ReadonlySet<string>, b: readonly string[]) =>
  a.size === b.length && b.every((k) => a.has(k))

/**
 * Name, who the role is for, and a grid of modules × permissions. Boxes the
 * editor does not hold are shown but locked (the API refuses them anyway).
 * In `view` mode nothing can change: built-in roles, or roles above you.
 */
export function RoleEditor({
  mode,
  initial,
  catalog,
  held,
  usage,
  notice,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit' | 'view'
  initial: RoleDraft
  catalog: RoleCatalog
  held: ReadonlySet<string>
  usage?: { people: number; invitations: number }
  /** Shown above the form, e.g. why it is read-only. */
  notice?: React.ReactNode
  submitLabel: string
  onSubmit: (draft: RoleDraft) => Promise<void>
  onCancel: () => void
}) {
  const readOnly = mode === 'view'
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [scope, setScope] = useState<RoleScope>(initial.scope)
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initial.permissions),
  )

  const available = useMemo(
    () => permissionsForScope(catalog.permissions, scope),
    [catalog.permissions, scope],
  )
  const groups = useMemo(
    () =>
      catalog.modules
        .map((m) => ({
          ...m,
          permissions: available.filter((p) => p.module_key === m.key),
        }))
        .filter((m) => m.permissions.length > 0),
    [catalog.modules, available],
  )

  const dirty =
    !readOnly &&
    (name !== initial.name ||
      description !== initial.description ||
      scope !== initial.scope ||
      !sameSet(selected, initial.permissions))

  // Leaving with unsaved changes asks first (in-app links and the tab closing).
  const saving = useRef(false)
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !saving.current,
    enableBeforeUnload: () => dirty && !saving.current,
    withResolver: true,
  })

  const form = useFormAction(draftSchema, async (values) => {
    saving.current = true
    try {
      await onSubmit(values)
    } catch (err) {
      saving.current = false
      throw err
    }
  })

  const canTick = (key: string) => !readOnly && held.has(key)

  function toggle(key: string, on: boolean) {
    form.clearField('permissions')
    setSelected((current) =>
      on
        ? tick(current, key, catalog.permissions)
        : untick(current, key, catalog.permissions),
    )
  }

  function toggleModule(keys: string[], on: boolean) {
    form.clearField('permissions')
    setSelected((current) =>
      keys.reduce<ReadonlySet<string>>(
        (acc, key) =>
          on
            ? tick(acc, key, catalog.permissions)
            : untick(acc, key, catalog.permissions),
        current,
      ),
    )
  }

  function changeScope(next: RoleScope) {
    setScope(next)
    // Organization permissions make no sense on a tenant role: drop them.
    const allowed = new Set(
      permissionsForScope(catalog.permissions, next).map((p) => p.key),
    )
    setSelected(
      (current) => new Set([...current].filter((k) => allowed.has(k))),
    )
  }

  return (
    <form
      noValidate
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit({
          name,
          description,
          scope,
          permissions: [...selected],
        })
      }}
    >
      <div className="flex flex-col gap-8 p-4 md:p-6">
        {notice && (
          <div className="flex gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
            <InfoIcon
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div>{notice}</div>
          </div>
        )}
        <FormError message={form.error} />

        <section className="grid gap-4 md:grid-cols-[14rem_1fr] md:gap-8">
          <div>
            <h2 className="font-medium">Details</h2>
            <p className="text-sm text-muted-foreground">
              Shown wherever roles are chosen.
            </p>
          </div>
          <div className="flex max-w-xl flex-col gap-4">
            <TextField
              name="name"
              label="Name"
              autoComplete="off"
              value={name}
              disabled={readOnly}
              onChange={(event) => {
                setName(event.target.value)
                form.clearField('name')
              }}
              error={form.fields.name}
            />
            <Field data-invalid={form.fields.description ? true : undefined}>
              <FieldLabel htmlFor="description">Description</FieldLabel>
              <Textarea
                id="description"
                name="description"
                rows={2}
                value={description}
                disabled={readOnly}
                placeholder="What this role is for"
                onChange={(event) => {
                  setDescription(event.target.value)
                  form.clearField('description')
                }}
              />
              {form.fields.description && (
                <FieldError>{form.fields.description}</FieldError>
              )}
            </Field>
            <Field>
              <FieldLabel>Who it is for</FieldLabel>
              {mode === 'create' ? (
                <RadioGroup
                  value={scope}
                  onValueChange={(value) => changeScope(value as RoleScope)}
                  className="gap-2"
                >
                  <ScopeOption value="tenant" title="People in a tenant">
                    Given when inviting someone to a tenant. Applies in that
                    tenant only.
                  </ScopeOption>
                  <ScopeOption value="org" title="The whole organization">
                    Given to admins. Applies in every tenant, and can include
                    organization permissions.
                  </ScopeOption>
                </RadioGroup>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {scope === 'org'
                    ? 'The whole organization: applies in every tenant.'
                    : 'People in a tenant: applies in the tenant they are in.'}{' '}
                  This cannot change after the role is created.
                </p>
              )}
            </Field>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-[14rem_1fr] md:gap-8">
          <div>
            <h2 className="font-medium">Permissions</h2>
            <p className="text-sm text-muted-foreground">
              Ticking one ticks what it needs; for example, editing projects
              needs seeing them.
            </p>
            {form.fields.permissions && (
              <FieldError className="mt-2">
                {form.fields.permissions}
              </FieldError>
            )}
          </div>
          <div className="divide-y rounded-lg border">
            {groups.map((group) => {
              const keys = group.permissions.map((p) => p.key)
              const editable = keys.filter(canTick)
              const on = keys.filter((k) => selected.has(k)).length
              return (
                <div
                  key={group.key}
                  className="grid gap-3 p-3 sm:grid-cols-[10rem_1fr]"
                >
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox
                      checked={on === keys.length}
                      indeterminate={on > 0 && on < keys.length}
                      disabled={editable.length === 0}
                      onCheckedChange={(checked) =>
                        toggleModule(editable, checked)
                      }
                      aria-label={`All of ${group.label}`}
                    />
                    {group.label}
                  </label>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {group.permissions.map((p) => {
                      const locked = !readOnly && !held.has(p.key)
                      return (
                        <label
                          key={p.key}
                          className="flex items-center gap-2 text-sm data-[locked=true]:text-muted-foreground"
                          data-locked={locked}
                          title={
                            locked
                              ? "You don't have this permission, so you can't give it."
                              : undefined
                          }
                        >
                          <Checkbox
                            checked={selected.has(p.key)}
                            disabled={!canTick(p.key)}
                            onCheckedChange={(checked) =>
                              toggle(p.key, checked)
                            }
                          />
                          {p.label}
                          {locked && (
                            <LockIcon className="size-3" aria-hidden="true" />
                          )}
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      {/* Stays in view while scrolling the grid. */}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur md:px-6">
        <p className="mr-auto text-sm text-muted-foreground">
          {selected.size} {selected.size === 1 ? 'permission' : 'permissions'}
          {mode === 'edit' && usage && usage.people > 0 && (
            <>
              {' · '}
              {usage.people} {usage.people === 1 ? 'person has' : 'people have'}{' '}
              this role; changes apply to them right away
            </>
          )}
        </p>
        <Button type="button" variant="outline" onClick={onCancel}>
          {readOnly ? 'Back' : 'Cancel'}
        </Button>
        {!readOnly && (
          <SubmitButton pending={form.pending}>{submitLabel}</SubmitButton>
        )}
      </div>

      <AlertDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This role has changes that are not saved yet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => blocker.proceed?.()}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  )
}

function ScopeOption({
  value,
  title,
  children,
}: {
  value: RoleScope
  title: string
  children: React.ReactNode
}) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-lg border p-3 has-data-checked:border-primary has-data-checked:bg-muted/40">
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{children}</span>
      </span>
    </label>
  )
}
