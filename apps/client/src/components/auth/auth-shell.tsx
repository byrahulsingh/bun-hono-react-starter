import { useEffect } from 'react'

import { BrandMark } from '#/components/app/brand-mark'
import { pageTitle, useBranding } from '#/lib/branding'

/**
 * The frame of every signed-out page (login-02 layout): the form on the left,
 * a quiet panel on the right on wide screens.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  const productName = useBranding((s) => s.product_name)
  useEffect(() => {
    document.title = pageTitle()
  }, [productName])
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <BrandMark />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">{children}</div>
        </div>
      </div>
      <div className="relative hidden bg-muted lg:block" aria-hidden="true">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,var(--color-background),transparent_60%)] opacity-70" />
      </div>
    </div>
  )
}

/** Title and one line of explanation above a form. */
export function AuthHeading({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <h1 className="text-2xl font-bold">{title}</h1>
      {children && (
        <p className="text-sm text-balance text-muted-foreground">{children}</p>
      )}
    </div>
  )
}
