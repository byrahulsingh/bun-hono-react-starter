import { Link } from '@tanstack/react-router'
import { Loader2Icon } from 'lucide-react'
import { useState } from 'react'

import { FormSection } from '#/components/app/form-section'
import { FormError } from '#/components/auth/form-parts'
import { errorMessage } from '#/components/people/people-parts'
import { Button } from '#/components/ui/button'
import { RadioGroup, RadioGroupItem } from '#/components/ui/radio-group'
import { toast } from '#/components/ui/toast'
import type { SecuritySettings, TwoFactorPolicy } from '#/lib/api/settings'
import { settingsApi } from '#/lib/api/settings'

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

/** Who must use two-factor sign-in. */
export function SecurityTab({
  security,
  tenantId,
  onSaved,
}: {
  security: SecuritySettings
  tenantId: string
  onSaved: () => Promise<void>
}) {
  const [policy, setPolicy] = useState<TwoFactorPolicy>(
    security.two_factor_policy,
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const missing = security.without_two_factor
  // Requiring it without having it would lock you out of your own next sign-in.
  const locked = !security.you_have_two_factor

  const options: { value: TwoFactorPolicy; title: string; detail: string }[] = [
    {
      value: 'off',
      title: 'Nobody required',
      detail: 'Each person decides on their Account page.',
    },
    {
      value: 'org_roles',
      title: 'Owners and admins',
      detail:
        missing.org_roles > 0
          ? `${people(missing.org_roles)} with an organization role will set it up at their next sign-in.`
          : 'Everyone with an organization role already uses it.',
    },
    {
      value: 'everyone',
      title: 'Everyone',
      detail:
        missing.everyone > 0
          ? `${people(missing.everyone)} will set it up at their next sign-in, and new people as they accept their invitation.`
          : 'Everyone already uses it.',
    },
  ]

  async function save() {
    setPending(true)
    setError(null)
    try {
      await settingsApi.saveSecurity(policy)
      toast.add({ title: 'Security settings saved', type: 'success' })
      await onSaved()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <FormSection
      title="Two-factor sign-in"
      description="Who must enter a code from an authenticator app as well as their password. People already signed in stay signed in; the rule applies at their next sign-in."
    >
      <div className="flex max-w-xl flex-col gap-4">
        {locked && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            Turn on two-factor sign-in for your own account first, on your{' '}
            <Link
              to="/t/$tenantId/account"
              params={{ tenantId }}
              className="font-medium underline underline-offset-3"
            >
              Account page
            </Link>
            . Then you can require it for others.
          </p>
        )}
        <RadioGroup
          value={policy}
          onValueChange={(value) => setPolicy(value as TwoFactorPolicy)}
          className="gap-2"
          aria-label="Who must use two-factor sign-in"
        >
          {options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer gap-3 rounded-lg border p-3 has-data-checked:border-primary has-data-checked:bg-muted/40 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-60"
            >
              <RadioGroupItem
                value={o.value}
                className="mt-0.5"
                disabled={locked && o.value !== 'off'}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{o.title}</span>
                <span className="text-xs text-muted-foreground">
                  {o.detail}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <FormError message={error} />
        <div>
          <Button
            onClick={() => void save()}
            disabled={pending || policy === security.two_factor_policy}
            aria-busy={pending}
          >
            {pending && (
              <Loader2Icon className="animate-spin" aria-hidden="true" />
            )}
            Save
          </Button>
        </div>
      </div>
    </FormSection>
  )
}
