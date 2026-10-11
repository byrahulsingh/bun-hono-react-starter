import { Link } from '@tanstack/react-router'
import { MailWarningIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '#/components/ui/button'
import type { EmailStatus } from '#/lib/api/settings'
import { settingsApi } from '#/lib/api/settings'

const CHECK_EVERY_MS = 5 * 60 * 1000

/**
 * A bar across the page when emails are failing, for the people who can fix
 * it (org.settings.manage). Invitations and resets fail quietly otherwise:
 * the server log is the only other place that says so.
 */
export function EmailWarning({ tenantId }: { tenantId: string }) {
  const [status, setStatus] = useState<EmailStatus | null>(null)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let alive = true
    const check = () =>
      settingsApi.emailStatus().then(
        (s) => alive && setStatus(s),
        // A warning about warnings helps nobody: try again next time.
        () => {},
      )
    void check()
    const timer = setInterval(() => void check(), CHECK_EVERY_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  if (hidden || !status || (status.failing === 0 && status.delayed === 0))
    return null

  const parts = [
    status.failing > 0 &&
      `${status.failing} email${status.failing === 1 ? '' : 's'} could not be sent`,
    status.delayed > 0 &&
      `${status.delayed} ${status.delayed === 1 ? 'is' : 'are'} waiting to retry`,
  ].filter(Boolean)

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <MailWarningIcon className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Email isn't working.</span>{' '}
        {parts.join('; ')}. Invitations and password resets may not arrive.{' '}
        <Link
          to="/t/$tenantId/org/settings"
          params={{ tenantId }}
          search={{ tab: 'email' }}
          className="font-medium underline underline-offset-3"
        >
          See email settings
        </Link>
      </p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Hide until next visit"
        onClick={() => setHidden(true)}
      >
        <XIcon />
      </Button>
    </div>
  )
}
