import { Loader2Icon } from 'lucide-react'
import { useId } from 'react'

import { Button } from '#/components/ui/button'
import { Field, FieldError, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'

/** A labelled input with its error underneath, wired for screen readers. */
export function TextField({
  name,
  label,
  error,
  aside,
  ...props
}: React.ComponentProps<typeof Input> & {
  name: string
  label: string
  error?: string
  /** Shown at the right of the label, e.g. a "Forgot password?" link. */
  aside?: React.ReactNode
}) {
  // Unique per field, not the name: two forms on one page (a dialog over the
  // Account page) may both have a "password", and a label must find its own.
  const id = useId()
  const errorId = `${id}-error`
  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex items-center">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      <Input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...props}
      />
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  )
}

export function SubmitButton({
  pending,
  children,
}: {
  pending: boolean
  children: React.ReactNode
}) {
  return (
    <Button type="submit" disabled={pending} aria-busy={pending}>
      {pending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
      {children}
    </Button>
  )
}

/** One message for the whole form (wrong password, rate limit, offline). */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <FieldError className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
      {message}
    </FieldError>
  )
}
