import { Loader2Icon, WifiOffIcon, ShieldAlertIcon } from 'lucide-react'

import { Button } from '#/components/ui/button'

/**
 * Shown while the stored session is checked at start-up, and while a route
 * waits on the server. Fades in after a moment, so fast loads never flash it.
 */
export function FullScreenLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <div
        role="status"
        aria-live="polite"
        className="flex animate-in flex-col items-center gap-3 text-muted-foreground delay-200 duration-300 fill-mode-both fade-in"
      >
        <Loader2Icon className="size-6 animate-spin" aria-hidden="true" />
        <span className="text-sm">{label}…</span>
      </div>
    </div>
  )
}

function StatusScreen({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  )
}

/** A stored session exists, but the server could not be reached to check it. */
export function ServerUnavailable({
  problem,
  onRetry,
}: {
  problem: string | null
  onRetry: () => void
}) {
  return (
    <StatusScreen
      icon={<WifiOffIcon className="size-6" />}
      title="Can't reach the server"
    >
      <p className="text-sm text-balance text-muted-foreground">
        {problem ?? 'Check your connection.'} You are still signed in on this
        device.
      </p>
      <Button onClick={onRetry}>Try again</Button>
    </StatusScreen>
  )
}

/** WebCrypto is only available on https (or localhost). */
export function InsecureOrigin() {
  return (
    <StatusScreen
      icon={<ShieldAlertIcon className="size-6" />}
      title="Secure connection required"
    >
      <p className="text-sm text-balance text-muted-foreground">
        This app signs you in with keys that only exist on secure pages. Open it
        with an
        <code className="mx-1 rounded bg-muted px-1">https://</code>
        address.
      </p>
    </StatusScreen>
  )
}
