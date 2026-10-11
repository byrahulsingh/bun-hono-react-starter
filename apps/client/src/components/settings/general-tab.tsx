import { Link } from '@tanstack/react-router'
import { z } from 'zod'

import { FormSection } from '#/components/app/form-section'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { formatDate } from '#/components/people/people-parts'
import { toast } from '#/components/ui/toast'
import { settingsApi } from '#/lib/api/settings'
import { name } from '#/lib/auth/forms'
import { formValues, useFormAction } from '#/lib/use-form-action'

const generalSchema = z.object({ name })

export function GeneralTab({
  general,
  tenantId,
  onSaved,
}: {
  general: { name: string; created_at: string }
  tenantId: string
  onSaved: () => Promise<void>
}) {
  const form = useFormAction(generalSchema, async (values) => {
    await settingsApi.rename(values.name)
    await onSaved()
    toast.add({ title: 'Organization renamed', type: 'success' })
  })

  return (
    <FormSection
      title="Organization"
      description={`The company this install belongs to. Set up on ${formatDate(general.created_at)}.`}
    >
      <form
        noValidate
        className="flex max-w-md flex-col gap-4"
        onInput={() => form.clearField('name')}
        onSubmit={(event) => {
          event.preventDefault()
          void form.submit(formValues(event.currentTarget))
        }}
      >
        <FormError message={form.error} />
        <TextField
          name="name"
          label="Organization name"
          autoComplete="organization"
          defaultValue={general.name}
          error={form.fields.name}
        />
        <p className="text-sm text-muted-foreground">
          Used in organization invitations. Your Main tenant keeps its own name;
          rename it on the{' '}
          <Link
            to="/t/$tenantId/org/tenants"
            params={{ tenantId }}
            className="underline underline-offset-3"
          >
            Tenants
          </Link>{' '}
          page.
        </p>
        <div>
          <SubmitButton pending={form.pending}>Save</SubmitButton>
        </div>
      </form>
    </FormSection>
  )
}
