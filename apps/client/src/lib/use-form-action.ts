import { useState } from 'react'
import type { z } from 'zod'

import { ApiError, fieldErrors } from '#/lib/api/api'

/**
 * Form submit state in one place: validates with a zod schema first (so
 * obvious mistakes never reach the server), then runs the action and turns a
 * failure into per-field messages or one form-level message.
 *
 * Messages shown are the server's, which are written to be safe for anyone to
 * read (no account enumeration, no internals); anything unexpected becomes a
 * generic sentence, never a stack trace.
 */
export function useFormAction<TSchema extends z.ZodType>(
  schema: TSchema,
  action: (values: z.infer<TSchema>) => Promise<void>,
) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})

  async function submit(values: unknown) {
    if (pending) return
    setError(null)
    setFields({})

    const parsed = schema.safeParse(values)
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues)
        next[issue.path.join('.') || '_'] ??= issue.message
      setFields(next)
      return
    }

    setPending(true)
    try {
      await action(parsed.data)
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length > 0) setFields(byField)
      else
        setError(
          err instanceof ApiError
            ? err.message
            : 'Something went wrong. Try again.',
        )
    } finally {
      setPending(false)
    }
  }

  /** Drops a field's message once the person changes that field. */
  function clearField(name: string) {
    setFields((current) => {
      if (!(name in current)) return current
      const { [name]: _removed, ...rest } = current
      return rest
    })
  }

  return { pending, error, fields, submit, clearField }
}

/** `{ ...Object.fromEntries(new FormData(form)) }` with string values only. */
export function formValues(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of new FormData(form))
    if (typeof value === 'string') out[key] = value
  return out
}
