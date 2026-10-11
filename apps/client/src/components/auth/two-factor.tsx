import { CheckIcon, CopyIcon, DownloadIcon, Loader2Icon } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useId, useState } from 'react'
import { z } from 'zod'

import { AuthHeading } from '#/components/auth/auth-shell'
import { FormError, SubmitButton } from '#/components/auth/form-parts'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Field, FieldError, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { ApiError } from '#/lib/api/api'
import { useBranding } from '#/lib/branding'
import type { TwoFactorChallenge } from '#/lib/auth/session'
import { formValues, useFormAction } from '#/lib/use-form-action'

/**
 * The pieces of two-factor sign-in, shared by the sign-in pages and the
 * Account page: entering a code, setting an authenticator app up, and
 * showing recovery codes once.
 */

const codeSchema = z.object({
  code: z.string().trim().min(1, 'Enter the code'),
})

const CODE_KINDS = {
  app: {
    label: 'Code from your app',
    placeholder: '123456',
    max: 6,
    mode: 'numeric',
    auto: 'one-time-code',
  },
  recovery: {
    label: 'Recovery code',
    placeholder: 'abcde-fghjk',
    max: 32,
    mode: 'text',
    auto: 'off',
  },
  either: {
    label: 'Code from your app, or a recovery code',
    placeholder: '123456',
    max: 32,
    mode: 'text',
    auto: 'one-time-code',
  },
} as const

/** A code field: 6 digits from the app, a recovery code, or either. */
export function CodeField({
  error,
  kind = 'app',
  autoFocus = true,
}: {
  error?: string
  kind?: keyof typeof CODE_KINDS
  autoFocus?: boolean
}) {
  const id = useId()
  const k = CODE_KINDS[kind]
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{k.label}</FieldLabel>
      <Input
        id={id}
        name="code"
        // `key`: switching kind starts the field empty.
        key={kind}
        autoFocus={autoFocus}
        autoComplete={k.auto}
        inputMode={k.mode}
        placeholder={k.placeholder}
        maxLength={k.max}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        className="font-mono tracking-widest"
      />
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/** The link an authenticator app reads from the QR code. */
function otpauthUri(issuer: string, secret: string, account?: string) {
  const label = account
    ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
    : encodeURIComponent(issuer)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  return `otpauth://totp/${label}?${params}`
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
      }
    >
      {copied ? (
        <CheckIcon aria-hidden="true" />
      ) : (
        <CopyIcon aria-hidden="true" />
      )}
      {copied ? 'Copied' : label}
    </Button>
  )
}

/**
 * Setting an authenticator app up: scan (or type) the secret, then prove it
 * works with the first code. `start` gets the secret; `finish` sends the code
 * and returns the recovery codes.
 */
export function TwoFactorEnroll({
  account,
  start,
  finish,
  onCodes,
}: {
  /** Shown in the app next to the codes (the email). */
  account?: string
  start: () => Promise<string>
  finish: (code: string) => Promise<string[]>
  onCodes: (codes: string[]) => void
}) {
  const issuer = useBranding((s) => s.product_name)
  const [secret, setSecret] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const form = useFormAction(codeSchema, async ({ code }) => {
    onCodes(await finish(code))
  })

  useEffect(() => {
    let alive = true
    start().then(
      (s) => alive && setSecret(s),
      (err: unknown) =>
        alive &&
        setStartError(
          err instanceof ApiError
            ? err.message
            : 'Something went wrong. Try again.',
        ),
    )
    return () => {
      alive = false
    }
    // Once per mount: a second call would replace the secret just scanned.
  }, [])

  if (startError) return <FormError message={startError} />
  if (!secret) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        Preparing…
      </div>
    )
  }

  const grouped = secret.match(/.{1,4}/g)?.join(' ') ?? secret
  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onInput={() => form.clearField('code')}
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm">
        <li>
          Open an authenticator app (Google Authenticator, Microsoft
          Authenticator, 1Password, Authy…) and scan this code.
          <div
            className="mt-3 w-fit rounded-lg border bg-white p-3"
            role="img"
            aria-label="QR code for your authenticator app"
          >
            <QRCodeSVG value={otpauthUri(issuer, secret, account)} size={168} />
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-muted-foreground">
              Can't scan? Enter a key instead
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code
                className="rounded-md bg-muted px-2 py-1 font-mono text-sm break-all"
                aria-label="Setup key"
              >
                {grouped}
              </code>
              <CopyButton text={secret} label="Copy key" />
            </div>
          </details>
        </li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <FormError message={form.error} />
      <CodeField error={form.fields.code} autoFocus={false} />
      <div>
        <SubmitButton pending={form.pending}>Turn on</SubmitButton>
      </div>
    </form>
  )
}

/** Recovery codes, shown once: copy, download, and confirm they are saved. */
export function RecoveryCodes({
  codes,
  onDone,
  doneLabel = 'Continue',
}: {
  codes: string[]
  onDone: () => void | Promise<void>
  doneLabel?: string
}) {
  const issuer = useBranding((s) => s.product_name)
  const [saved, setSaved] = useState(false)
  const [pending, setPending] = useState(false)
  const text = codes.join('\n')

  function download() {
    const body = `${issuer} recovery codes\nEach works once, instead of a code from your app.\n\n${text}\n`
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        If you lose your phone, each of these works once instead of a code. Keep
        them somewhere safe, like a password manager.{' '}
        <strong className="font-medium text-foreground">
          They won't be shown again.
        </strong>
      </p>
      <ul
        className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border bg-muted/40 p-4 font-mono text-sm"
        aria-label="Recovery codes"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={text} label="Copy all" />
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <DownloadIcon aria-hidden="true" />
          Download
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={saved}
          onCheckedChange={(checked) => setSaved(checked)}
        />
        I've saved these codes
      </label>
      <div>
        <Button
          disabled={!saved || pending}
          aria-busy={pending}
          onClick={() => {
            setPending(true)
            void Promise.resolve(onDone()).finally(() => setPending(false))
          }}
        >
          {doneLabel}
        </Button>
      </div>
    </div>
  )
}

/**
 * The step after the password on a sign-in page: a code, or (when the
 * organization requires two-factor and it is not set up) setting it up.
 */
export function TwoFactorSignIn({
  challenge,
  account,
  onSignedIn,
  onRestart,
}: {
  challenge: TwoFactorChallenge
  account?: string
  onSignedIn: () => void
  onRestart: () => void
}) {
  const [recovery, setRecovery] = useState(false)
  const [codes, setCodes] = useState<{
    recoveryCodes: string[]
    signIn: () => Promise<void>
  } | null>(null)
  const [expired, setExpired] = useState(false)

  const form = useFormAction(codeSchema, async ({ code }) => {
    try {
      await challenge.verify(code)
      onSignedIn()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'LINK_INVALID')
        setExpired(true)
      throw err
    }
  })

  const restart = (
    <Button type="button" variant="link" className="px-0" onClick={onRestart}>
      Start again
    </Button>
  )

  if (challenge.step === 'setup') {
    if (codes) {
      return (
        <div className="flex flex-col gap-6">
          <AuthHeading title="Save your recovery codes" />
          <RecoveryCodes
            codes={codes.recoveryCodes}
            onDone={async () => {
              await codes.signIn()
              onSignedIn()
            }}
          />
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-6">
        <AuthHeading title="Set up two-factor sign-in">
          Your organization asks for a code from an authenticator app as well as
          your password.
        </AuthHeading>
        <TwoFactorEnroll
          account={account}
          start={challenge.startSetup}
          finish={async (code) => {
            const done = await challenge.finishSetup(code)
            setCodes(done)
            return done.recoveryCodes
          }}
          onCodes={() => {}}
        />
        {restart}
      </div>
    )
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onInput={() => form.clearField('code')}
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <AuthHeading title="Two-factor sign-in">
        {recovery
          ? 'Enter one of your recovery codes. Each works once.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </AuthHeading>
      <FormError message={form.error} />
      {!expired && (
        <>
          <CodeField
            error={form.fields.code}
            kind={recovery ? 'recovery' : 'app'}
          />
          <SubmitButton pending={form.pending}>Continue</SubmitButton>
          <Button
            type="button"
            variant="link"
            className="px-0"
            onClick={() => {
              setRecovery((r) => !r)
              form.clearField('code')
            }}
          >
            {recovery ? 'Use a code from your app' : 'Use a recovery code'}
          </Button>
        </>
      )}
      {restart}
    </form>
  )
}
