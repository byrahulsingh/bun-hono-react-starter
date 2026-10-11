import { Link } from '@tanstack/react-router'
import { LockIcon } from 'lucide-react'

import { buttonVariants } from '#/components/ui/button'
import { Skeleton } from '#/components/ui/skeleton'

/** Thrown by a page guard when the signed-in person lacks a permission. */
export class ForbiddenError extends Error {
  constructor() {
    super("You don't have permission to see this page.")
    this.name = 'ForbiddenError'
  }
}

export function NoPermission() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <LockIcon className="size-5" aria-hidden="true" />
        </div>
        <h2 className="font-semibold">No access</h2>
        <p className="text-sm text-muted-foreground">
          Your role does not include this page. Ask a manager if you need it.
        </p>
      </div>
    </div>
  )
}

/** Placeholder for pages built in later steps. */
export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="grid auto-rows-min gap-4 md:grid-cols-3">
        <Skeleton className="aspect-video rounded-xl" />
        <Skeleton className="aspect-video rounded-xl" />
        <Skeleton className="aspect-video rounded-xl" />
      </div>
      <div className="flex min-h-64 flex-1 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
        {title} is coming in a later step.
      </div>
    </div>
  )
}

/** While a tenant's permissions load: the shape of the page, no content. */
export function ContentSkeleton() {
  return (
    <div
      className="flex flex-1 flex-col gap-4 p-4"
      aria-busy="true"
      aria-label="Loading"
    >
      <Skeleton className="h-8 w-48" />
      <div className="grid auto-rows-min gap-4 md:grid-cols-3">
        <Skeleton className="aspect-video rounded-xl" />
        <Skeleton className="aspect-video rounded-xl" />
        <Skeleton className="aspect-video rounded-xl" />
      </div>
      <Skeleton className="min-h-64 flex-1 rounded-xl" />
    </div>
  )
}

export function TenantNotFound() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold">Tenant not found</h1>
        <p className="text-sm text-muted-foreground">
          It does not exist, or you don't have access to it.
        </p>
        <Link to="/" className={buttonVariants()}>
          Go to your workspace
        </Link>
      </div>
    </div>
  )
}
