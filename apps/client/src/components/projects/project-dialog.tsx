import { useId } from 'react'
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
import { Field, FieldError, FieldLabel } from '#/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Textarea } from '#/components/ui/textarea'
import { toast } from '#/components/ui/toast'
import type { Project } from '#/lib/api/projects'
import { PROJECT_STATUS_LABELS, projectsApi } from '#/lib/api/projects'
import { formValues, useFormAction } from '#/lib/use-form-action'

// The same rules as the API's, so obvious mistakes never leave the browser.
// The API checks again: this is for the experience, not the safety.
const fields = {
  name: z.string().trim().min(1, 'Required').max(100, 'At most 100 characters'),
  description: z.string().trim().max(2000, 'At most 2000 characters'),
}
const createSchema = z.object(fields)
const editSchema = z.object({
  ...fields,
  status: z.enum(['active', 'on_hold', 'done'], 'Choose a status'),
})

/** Creates a project (`project` null) or edits one. */
export function ProjectDialog({
  tenantId,
  project,
  open,
  onOpenChange,
  onDone,
}: {
  tenantId: string
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Inside the popup, so each opening starts from the saved values. */}
        <ProjectForm
          tenantId={tenantId}
          project={project}
          onDone={() => {
            onOpenChange(false)
            onDone()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function ProjectForm({
  tenantId,
  project,
  onDone,
}: {
  tenantId: string
  project: Project | null
  onDone: () => void
}) {
  const descriptionId = useId()
  const form = useFormAction(project ? editSchema : createSchema, async (values) => {
    if (project) {
      await projectsApi.update(tenantId, project.id, values)
      toast.add({ title: 'Project saved', type: 'success' })
    } else {
      const created = await projectsApi.create(tenantId, values)
      toast.add({ title: `${created.name} created`, type: 'success' })
    }
    onDone()
  })

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onInput={(event) => {
        const target = event.target as HTMLInputElement
        if (target.name) form.clearField(target.name)
      }}
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <DialogHeader>
        <DialogTitle>{project ? 'Edit project' : 'New project'}</DialogTitle>
        <DialogDescription>
          {project
            ? 'Changes are saved for everyone in this tenant.'
            : 'Everyone in this tenant who can see projects will see it.'}
        </DialogDescription>
      </DialogHeader>
      <FormError message={form.error} />
      <TextField
        name="name"
        label="Name"
        defaultValue={project?.name}
        autoComplete="off"
        autoFocus
        error={form.fields.name}
      />
      <Field data-invalid={form.fields.description ? true : undefined}>
        <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
        <Textarea
          id={descriptionId}
          name="description"
          rows={3}
          defaultValue={project?.description}
          placeholder="Optional"
          aria-invalid={form.fields.description ? true : undefined}
        />
        {form.fields.description && (
          <FieldError>{form.fields.description}</FieldError>
        )}
      </Field>
      {project && (
        <Field>
          <FieldLabel htmlFor="status">Status</FieldLabel>
          <Select
            name="status"
            items={PROJECT_STATUS_LABELS}
            defaultValue={project.status}
            onValueChange={() => form.clearField('status')}
          >
            <SelectTrigger id="status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {Object.entries(PROJECT_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {form.fields.status && <FieldError>{form.fields.status}</FieldError>}
        </Field>
      )}
      <DialogFooter>
        <SubmitButton pending={form.pending}>
          {project ? 'Save' : 'Create project'}
        </SubmitButton>
      </DialogFooter>
    </form>
  )
}
