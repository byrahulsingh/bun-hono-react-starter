import {
  CircleCheckIcon,
  Loader2Icon,
  MailWarningIcon,
  SendIcon,
} from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { FormSection } from '#/components/app/form-section'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { errorMessage } from '#/components/people/people-parts'
import { Button } from '#/components/ui/button'
import { RadioGroup, RadioGroupItem } from '#/components/ui/radio-group'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { toast } from '#/components/ui/toast'
import type {
  EmailProblem,
  EmailServerInput,
  EmailSettings,
} from '#/lib/api/settings'
import { settingsApi } from '#/lib/api/settings'
import { formValues, useFormAction } from '#/lib/use-form-action'

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})
const formatDateTime = (iso: string | null) =>
  iso ? dateTime.format(new Date(iso)) : '—'

export function EmailTab({
  email,
  onChanged,
}: {
  email: EmailSettings
  onChanged: () => Promise<void>
}) {
  return (
    <div className="flex flex-col gap-10">
      <Overview email={email} />
      <ServerSection email={email} onChanged={onChanged} />
      <TestSection checkedAt={email.checked_at} onSent={onChanged} />
      <ProblemsSection failed={email.failed} delayed={email.delayed} />
    </div>
  )
}

function Overview({ email }: { email: EmailSettings }) {
  const notSetUp = email.config.source === 'none'
  const trouble = notSetUp || email.delayed.length > 0 || recentFailure(email)
  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${trouble ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100' : ''}`}
    >
      {trouble ? (
        <MailWarningIcon
          className="mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
      ) : (
        <CircleCheckIcon
          className="mt-0.5 size-4 shrink-0 text-emerald-600"
          aria-hidden="true"
        />
      )}
      <p>
        {notSetUp
          ? 'Email is not set up yet: no invitation or password reset can reach anyone.'
          : trouble
            ? 'Some emails are not going out. See the problems below.'
            : email.last_sent_at
              ? `Email is working. The last one went out ${formatDateTime(email.last_sent_at)}.`
              : 'No problems so far. Send a test email to be sure.'}
      </p>
    </div>
  )
}

/** A failure newer than the last sign of working email (a send, or a test): broken now. */
function recentFailure(email: EmailSettings) {
  const time = (iso: string | null) => (iso ? Date.parse(iso) : 0)
  const last = Math.max(time(email.last_sent_at), time(email.checked_at))
  return email.failed.some((f) => time(f.at) > last)
}

/** Port, security and an example host for the common choices, to fill the form with. */
const SECURITY: {
  value: 'starttls' | 'tls'
  title: string
  detail: string
  port: number
}[] = [
  {
    value: 'starttls',
    title: 'STARTTLS',
    detail: 'Usually port 587. Encrypted after connecting.',
    port: 587,
  },
  {
    value: 'tls',
    title: 'TLS',
    detail: 'Usually port 465. Encrypted from the start.',
    port: 465,
  },
]

const serverSchema = z.object({
  host: z.string().trim().min(1, 'Required'),
  port: z.coerce
    .number<string>()
    .int('Enter a port')
    .min(1, 'Enter a port')
    .max(65535, 'Enter a port'),
  security: z.enum(['tls', 'starttls']),
  user: z.string().trim(),
  password: z.string(),
  from: z.string().trim().min(3, 'Required'),
})

function ServerSection({
  email,
  onChanged,
}: {
  email: EmailSettings
  onChanged: () => Promise<void>
}) {
  const { config, you_are_owner: owner } = email
  const fromEnv = config.source === 'environment'
  return (
    <FormSection
      title="Mail server"
      description={
        fromEnv ? (
          <>
            Set in the server's <code className="text-xs">.env</code> (
            <code className="text-xs">SMTP_*</code>,{' '}
            <code className="text-xs">MAIL_FROM</code>), which wins over
            settings made here. Change it there and restart the server.
          </>
        ) : (
          'The SMTP server that sends invitations, password resets and notices: Gmail or Google Workspace (app password), Microsoft 365, Amazon SES, SendGrid, or your own.'
        )
      }
    >
      <div className="flex max-w-xl flex-col gap-4">
        {config.source === 'none' && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            No mail server is set up, so no email can go out yet.
            {owner ? ' Enter yours below.' : ' Ask an owner to set it up.'}
          </p>
        )}
        {config.source === 'development' && (
          <p className="text-sm text-muted-foreground">
            Nothing is set, so emails go to the development mail catcher
            (Mailpit at localhost:8025).
          </p>
        )}
        {fromEnv || !owner ? (
          <>
            {config.host && <ServerDetails config={config} />}
            {!fromEnv && (
              <p className="text-sm text-muted-foreground">
                Only owners can change the mail server: it sees every email,
                password reset links included.
              </p>
            )}
          </>
        ) : (
          <ServerForm config={config} onChanged={onChanged} />
        )}
      </div>
    </FormSection>
  )
}

function ServerDetails({ config }: { config: EmailSettings['config'] }) {
  const rows: [string, React.ReactNode][] = [
    ['Server', `${config.host}:${config.port}`],
    [
      'Security',
      config.secure ? 'TLS from the start' : 'STARTTLS when offered',
    ],
    ['Username', config.user ?? 'None'],
    ['Password', config.password_set ? 'Set' : 'Not set'],
    ['Sender', config.from],
  ]
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ServerForm({
  config,
  onChanged,
}: {
  config: EmailSettings['config']
  onChanged: () => Promise<void>
}) {
  // The form starts from what is saved here; development defaults are not worth keeping.
  const saved = config.source === 'dashboard' ? config : null
  const [security, setSecurity] = useState<'tls' | 'starttls'>(
    saved?.secure ? 'tls' : 'starttls',
  )
  const [port, setPort] = useState(String(saved?.port ?? 587))
  const [checked, setChecked] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [removing, setRemoving] = useState(false)

  const input = (values: z.infer<typeof serverSchema>): EmailServerInput => ({
    host: values.host,
    port: values.port,
    security: values.security,
    from: values.from,
    ...(values.user && { user: values.user }),
    ...(values.password && { password: values.password }),
  })

  const form = useFormAction(serverSchema, async (values) => {
    await settingsApi.saveEmailServer(input(values))
    setChecked(null)
    toast.add({
      title: 'Mail server saved',
      description: 'Send a test email to see one arrive.',
      type: 'success',
    })
    await onChanged()
  })

  async function testConnection(formElement: HTMLFormElement) {
    const parsed = serverSchema.safeParse(formValues(formElement))
    if (!parsed.success) {
      void form.submit(formValues(formElement)) // shows the field messages; never saves invalid input
      return
    }
    setTesting(true)
    setChecked(null)
    try {
      await settingsApi.testEmailServer(input(parsed.data))
      setChecked(`Connected to ${parsed.data.host} and signed in.`)
    } catch (err) {
      setChecked(null)
      toast.add({ title: errorMessage(err), type: 'error' })
    } finally {
      setTesting(false)
    }
  }

  async function remove() {
    setRemoving(true)
    try {
      await settingsApi.removeEmailServer()
      toast.add({ title: 'Mail server removed', type: 'success' })
      await onChanged()
    } catch (err) {
      toast.add({ title: errorMessage(err), type: 'error' })
    } finally {
      setRemoving(false)
    }
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onInput={(event) => {
        setChecked(null)
        form.clearField((event.target as HTMLInputElement).name)
      }}
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <FormError message={form.error} />
      <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
        <TextField
          name="host"
          label="Server"
          placeholder="smtp.example.com"
          defaultValue={saved?.host ?? ''}
          autoComplete="off"
          spellCheck={false}
          error={form.fields.host}
        />
        <TextField
          name="port"
          label="Port"
          inputMode="numeric"
          value={port}
          onChange={(event) => setPort(event.target.value)}
          error={form.fields.port}
        />
      </div>
      <input type="hidden" name="security" value={security} />
      <RadioGroup
        value={security}
        onValueChange={(value) => {
          const next = SECURITY.find((o) => o.value === value)!
          setSecurity(next.value)
          // Moving between the usual ports follows the choice; a custom port stays.
          if (SECURITY.some((o) => String(o.port) === port))
            setPort(String(next.port))
          setChecked(null)
        }}
        className="grid gap-2 sm:grid-cols-2"
        aria-label="Security"
      >
        {SECURITY.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer gap-3 rounded-lg border p-3 has-data-checked:border-primary has-data-checked:bg-muted/40"
          >
            <RadioGroupItem value={o.value} className="mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{o.title}</span>
              <span className="text-xs text-muted-foreground">{o.detail}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      <TextField
        name="user"
        label="Username"
        defaultValue={saved?.user ?? ''}
        autoComplete="off"
        spellCheck={false}
        error={form.fields.user}
      />
      <TextField
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        placeholder={
          saved?.password_set ? 'Leave empty to keep the saved password' : ''
        }
        error={form.fields.password}
      />
      <TextField
        name="from"
        label="Send as"
        placeholder="hello@example.com"
        defaultValue={saved?.from ?? ''}
        autoComplete="off"
        spellCheck={false}
        error={form.fields.from}
      />
      <p className="-mt-2 text-xs text-muted-foreground">
        An address this account may send from. On its own, emails show your
        product name as the sender; write Name &lt;address&gt; to choose the
        name.
      </p>
      {checked && (
        <p
          className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"
          role="status"
        >
          <CircleCheckIcon className="size-4" aria-hidden="true" />
          {checked}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={form.pending}>Save</SubmitButton>
        <Button
          type="button"
          variant="outline"
          disabled={testing}
          aria-busy={testing}
          onClick={(event) => void testConnection(event.currentTarget.form!)}
        >
          {testing && (
            <Loader2Icon className="animate-spin" aria-hidden="true" />
          )}
          Test connection
        </Button>
        {saved && (
          <Button
            type="button"
            variant="ghost"
            disabled={removing}
            onClick={() => void remove()}
          >
            Remove
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Saving connects and signs in first, so settings that don't work are
        never saved.
      </p>
    </form>
  )
}

function TestSection({
  checkedAt,
  onSent,
}: {
  checkedAt: string | null
  onSent: () => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<
    { ok: true; to: string } | { ok: false; message: string } | null
  >(null)

  async function send() {
    setPending(true)
    setResult(null)
    try {
      const { sent_to } = await settingsApi.testEmail()
      setResult({ ok: true, to: sent_to })
      await onSent()
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) })
    } finally {
      setPending(false)
    }
  }

  return (
    <FormSection
      title="Test"
      description="Sends a branded email to you right now, so you see the mail server's own answer."
    >
      <div className="flex flex-col items-start gap-3">
        <Button
          onClick={() => void send()}
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? (
            <Loader2Icon className="animate-spin" aria-hidden="true" />
          ) : (
            <SendIcon aria-hidden="true" />
          )}
          Send test email to me
        </Button>
        {result?.ok && (
          <p className="text-sm" role="status">
            Sent to <span className="font-medium">{result.to}</span>. Check your
            inbox, and the spam folder if it's not there in a minute.
          </p>
        )}
        {result && !result.ok && (
          <p className="text-sm text-destructive" role="alert">
            {result.message}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {checkedAt
            ? `Last successful test: ${formatDateTime(checkedAt)}.`
            : 'No test sent yet.'}
        </p>
      </div>
    </FormSection>
  )
}

function ProblemsSection({
  failed,
  delayed,
}: {
  failed: EmailProblem[]
  delayed: EmailProblem[]
}) {
  return (
    <FormSection
      title="Problems"
      description="Emails that could not be sent in the last 7 days, and ones waiting to retry. Each is retried for about 4 hours before it is given up."
    >
      <div className="flex flex-col gap-6">
        {failed.length === 0 && delayed.length === 0 && (
          <p className="text-sm text-muted-foreground">
            None. Every email went out.
          </p>
        )}
        {delayed.length > 0 && (
          <ProblemTable
            caption="Waiting to retry"
            problems={delayed}
            whenLabel="Next try"
          />
        )}
        {failed.length > 0 && (
          <>
            <ProblemTable
              caption="Could not be sent"
              problems={failed}
              whenLabel="Given up"
            />
            <p className="text-sm text-muted-foreground">
              Fix the mail server first (send a test email to check). Then
              resend what matters: invitations from the People or Admins page
              (“Resend”), and password resets from the Directory.
            </p>
          </>
        )}
      </div>
    </FormSection>
  )
}

function ProblemTable({
  caption,
  problems,
  whenLabel,
}: {
  caption: string
  problems: EmailProblem[]
  whenLabel: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{caption}</h3>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead className="hidden md:table-cell">Error</TableHead>
              <TableHead className="w-40">{whenLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {problems.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="max-w-64 whitespace-normal">
                  <div className="font-medium break-words">
                    {p.subject ?? 'Email'}
                  </div>
                  <div className="text-xs break-words text-muted-foreground">
                    To {p.recipient ?? 'unknown'} · {p.attempts}{' '}
                    {p.attempts === 1 ? 'try' : 'tries'}
                  </div>
                  <div className="mt-1 text-xs break-words text-muted-foreground md:hidden">
                    {p.last_error}
                  </div>
                </TableCell>
                <TableCell className="hidden max-w-80 font-mono text-xs whitespace-normal break-words text-muted-foreground md:table-cell">
                  {p.last_error ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(p.at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
