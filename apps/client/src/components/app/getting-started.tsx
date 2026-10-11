import { Link } from '@tanstack/react-router'
import { CheckIcon, XIcon } from 'lucide-react'
import { useState } from 'react'

import { errorMessage } from '#/components/people/people-parts'
import { Button, buttonVariants } from '#/components/ui/button'
import { Progress } from '#/components/ui/progress'
import { toast } from '#/components/ui/toast'
import type { Onboarding, OnboardingStepKey } from '#/lib/api/settings'
import { settingsApi } from '#/lib/api/settings'

type StepLink =
  | { to: '/t/$tenantId/org/settings'; search: { tab: 'branding' | 'email' } }
  | { to: '/t/$tenantId/people'; search?: undefined }
  | { to: '/t/$tenantId/org/tenants'; search?: undefined }

const STEPS: Record<
  OnboardingStepKey,
  { title: string; description: string; action: string; link: StepLink }
> = {
  branding: {
    title: 'Brand your workspace',
    description: 'Your product name, logo and colour, on every page and email.',
    action: 'Open branding',
    link: { to: '/t/$tenantId/org/settings', search: { tab: 'branding' } },
  },
  email: {
    title: 'Check that email works',
    description:
      'Send a test email, so invitations and password resets arrive.',
    action: 'Send a test',
    link: { to: '/t/$tenantId/org/settings', search: { tab: 'email' } },
  },
  team: {
    title: 'Invite your team',
    description: 'Paste a list of addresses and pick what they can do.',
    action: 'Invite people',
    link: { to: '/t/$tenantId/people' },
  },
  tenant: {
    title: 'Add a tenant for each client or team',
    description:
      'Each gets its own data and people. Skip it if you work only for yourselves.',
    action: 'Add a tenant',
    link: { to: '/t/$tenantId/org/tenants' },
  },
}

/**
 * The first things an owner should do after setup. Each step ticks itself off
 * from what really happened. Gone once the required ones are done, or hidden
 * for every settings manager with one click.
 */
export function GettingStarted({
  onboarding,
  tenantId,
}: {
  onboarding: Onboarding
  tenantId: string
}) {
  const [hidden, setHidden] = useState(false)
  if (hidden || onboarding.dismissed || onboarding.complete) return null

  const required = onboarding.steps.filter((s) => !s.optional)
  const done = required.filter((s) => s.done).length

  async function dismiss() {
    setHidden(true)
    try {
      await settingsApi.dismissOnboarding()
    } catch (err) {
      setHidden(false)
      toast.add({ title: errorMessage(err), type: 'error' })
    }
  }

  return (
    <section
      aria-labelledby="getting-started"
      className="flex flex-col gap-4 rounded-xl border p-4 md:p-6"
    >
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <h2 id="getting-started" className="font-semibold">
            Get started
          </h2>
          <p className="text-sm text-muted-foreground">
            {done} of {required.length} done. A few things to set up before your
            team joins.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Hide this checklist for everyone"
          title="Hide this checklist for everyone"
          onClick={() => void dismiss()}
        >
          <XIcon />
        </Button>
      </div>
      <Progress
        value={(done / required.length) * 100}
        aria-label="Setup progress"
      />
      <ol className="flex flex-col divide-y">
        {onboarding.steps.map((step) => {
          const info = STEPS[step.key]
          return (
            <li key={step.key} className="flex items-center gap-3 py-3">
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full border ${step.done ? 'border-primary bg-primary text-primary-foreground' : ''}`}
              >
                {step.done && (
                  <CheckIcon className="size-3.5" aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm font-medium ${step.done ? 'text-muted-foreground line-through' : ''}`}
                >
                  {info.title}
                  {step.optional && (
                    <span className="font-normal text-muted-foreground">
                      {' '}
                      (optional)
                    </span>
                  )}
                  <span className="sr-only">{step.done ? ', done' : ''}</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {info.description}
                </p>
              </div>
              {!step.done && (
                <Link
                  to={info.link.to}
                  params={{ tenantId }}
                  search={info.link.search}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {info.action}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
