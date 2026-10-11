import {
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  KeyRoundIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'

import { FormSection } from '#/components/app/form-section'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { ConfirmDialog } from '#/components/people/people-dialogs'
import { errorMessage, formatDate } from '#/components/people/people-parts'
import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '#/components/ui/field'
import { Textarea } from '#/components/ui/textarea'
import { toast } from '#/components/ui/toast'
import type {
  SsoConnection,
  SsoSettings,
  SsoTestResult,
} from '#/lib/api/settings'
import { settingsApi } from '#/lib/api/settings'
import { startSsoTest } from '#/lib/auth/session'
import { clearSsoTestResult, peekSsoTestResult } from '#/lib/auth/sso-answer'
import { formValues, useFormAction } from '#/lib/use-form-action'

const domainList = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((d) => d.trim())
    .filter(Boolean)

const connectionSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Required')
    .max(60, 'Use at most 60 characters'),
  issuer: z.string().trim().min(1, 'Required'),
  client_id: z.string().trim().min(1, 'Required'),
  client_secret: z.string().trim(),
  domains: z
    .string()
    .transform(domainList)
    .pipe(z.array(z.string()).min(1, 'Add at least one domain')),
})

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code
          className="rounded-md bg-muted px-2 py-1 font-mono text-sm break-all"
          aria-label={label}
        >
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(value).then(() => {
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
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

/**
 * Single sign-on through OpenID Connect providers. Everyone with settings
 * access sees it; only owners change it (a connection can vouch for anyone
 * in its domains, owners included).
 */
export function SsoTab({
  sso,
  returnTo,
  onChanged,
}: {
  sso: SsoSettings
  /** This page, for a test sign-in to come back to. */
  returnTo: string
  onChanged: () => Promise<void>
}) {
  // Back from a test sign-in: its result, shown once.
  const [result, setResult] = useState<SsoTestResult | null>(peekSsoTestResult)
  // Shown once: gone when the page is opened again.
  useEffect(() => clearSsoTestResult(), [])
  const [editing, setEditing] = useState<SsoConnection | 'new' | null>(null)
  const owner = sso.you_are_owner

  return (
    <FormSection
      title="Single sign-on"
      description="Let people sign in with your organization's identity provider (Okta, Microsoft Entra, Google Workspace, …) through OpenID Connect."
    >
      <div className="flex max-w-2xl flex-col gap-5">
        {!owner && (
          <p className="text-sm text-muted-foreground">
            Only owners can change single sign-on.
          </p>
        )}
        {result && (
          <TestResult result={result} onClose={() => setResult(null)} />
        )}

        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">
            At your provider, create an OpenID Connect web app (a confidential
            client using the authorization code flow) and give it this redirect
            URL. Then add it here with its issuer URL, client ID and secret.
          </p>
          <CopyField label="Redirect URL" value={sso.redirect_uri} />
        </div>

        {sso.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No connections yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {sso.connections.map((c) => (
              <ConnectionCard
                key={c.id}
                connection={c}
                owner={owner}
                returnTo={returnTo}
                onEdit={() => setEditing(c)}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}

        {owner && (
          <div>
            <Button onClick={() => setEditing('new')}>
              <KeyRoundIcon aria-hidden="true" />
              Add connection
            </Button>
          </div>
        )}
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent className="sm:max-w-lg">
          {editing !== null && (
            <ConnectionForm
              connection={editing === 'new' ? null : editing}
              onDone={async () => {
                setEditing(null)
                await onChanged()
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </FormSection>
  )
}

function TestResult({
  result,
  onClose,
}: {
  result: SsoTestResult
  onClose: () => void
}) {
  const claims = result.claims
  return (
    <Alert variant={result.ok ? 'default' : 'destructive'}>
      {result.ok ? (
        <CircleCheckIcon aria-hidden="true" />
      ) : (
        <TriangleAlertIcon aria-hidden="true" />
      )}
      <AlertTitle>
        {result.ok
          ? `Test sign-in with ${result.connection_name} worked`
          : `Test sign-in with ${result.connection_name} failed`}
      </AlertTitle>
      <AlertDescription>
        {result.problem && <p>{result.problem}</p>}
        {claims && (
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">Email</dt>
            <dd>
              {claims.email ?? 'none'}
              {claims.email_verified === true && ' (verified)'}
              {claims.email_verified === false && ' (not verified)'}
            </dd>
            <dt className="text-muted-foreground">Name</dt>
            <dd>{claims.name ?? 'none'}</dd>
            <dt className="text-muted-foreground">Subject</dt>
            <dd className="font-mono break-all">{claims.sub}</dd>
          </dl>
        )}
        <Button variant="link" className="h-auto px-0" onClick={onClose}>
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  )
}

function ConnectionCard({
  connection: c,
  owner,
  returnTo,
  onEdit,
  onChanged,
}: {
  connection: SsoConnection
  owner: boolean
  returnTo: string
  onEdit: () => void
  onChanged: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState<'require' | 'remove' | null>(null)
  const [testing, setTesting] = useState(false)

  async function test() {
    setTesting(true)
    try {
      await startSsoTest(c.id, returnTo)
    } catch (err) {
      setTesting(false)
      toast.add({ title: errorMessage(err), type: 'error' })
    }
  }

  async function stopRequiring() {
    try {
      await settingsApi.setSsoRequired(c.id, false)
      toast.add({
        title: `Passwords work again for ${c.domains.join(', ')}`,
        type: 'success',
      })
      await onChanged()
    } catch (err) {
      toast.add({ title: errorMessage(err), type: 'error' })
    }
  }

  return (
    <li
      className="flex flex-col gap-3 rounded-lg border p-4"
      aria-label={c.name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.name}</span>
        {c.required && <Badge>Required</Badge>}
        {c.tested_at ? (
          <Badge variant="secondary">Tested {formatDate(c.tested_at)}</Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-amber-700 dark:text-amber-400"
          >
            Not tested yet
          </Badge>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Domains</dt>
        <dd>{c.domains.join(', ')}</dd>
        <dt className="text-muted-foreground">Issuer</dt>
        <dd className="break-all">{c.issuer}</dd>
        <dt className="text-muted-foreground">Client ID</dt>
        <dd className="break-all">{c.client_id}</dd>
      </dl>
      {c.required && (
        <p className="text-sm text-muted-foreground">
          People in these domains sign in only with {c.name}. Owners can still
          use their password, in case the provider is down.
        </p>
      )}
      {owner && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={testing}
            aria-busy={testing}
            onClick={() => void test()}
          >
            Test sign-in
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          {c.required ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void stopRequiring()}
            >
              Stop requiring
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!c.tested_at}
              title={
                c.tested_at ? undefined : 'Run a test sign-in that works first'
              }
              onClick={() => setConfirm('require')}
            >
              Require for these domains
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirm('remove')}
          >
            Remove
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'require'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Require ${c.name}?`}
        description={`People with an email at ${c.domains.join(', ')} will sign in only with ${c.name}, and those signed in with a password are signed out now. Owners keep their password, so a broken provider can't lock everyone out.`}
        confirmLabel="Require"
        destructive={false}
        run={() => settingsApi.setSsoRequired(c.id, true)}
        done={`${c.name} is now required`}
        onDone={() => void onChanged()}
      />
      <ConfirmDialog
        open={confirm === 'remove'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Remove ${c.name}?`}
        description="Everyone signed in through it is signed out. People without a password will need a password reset link to get back in."
        confirmLabel="Remove"
        run={() => settingsApi.removeSso(c.id)}
        done={`${c.name} removed`}
        onDone={() => void onChanged()}
      />
    </li>
  )
}

function ConnectionForm({
  connection,
  onDone,
}: {
  connection: SsoConnection | null
  onDone: () => Promise<void>
}) {
  // Adding needs the secret; editing keeps the stored one unless a new one is typed.
  const schema = connection
    ? connectionSchema
    : connectionSchema.extend({
        client_secret: z.string().trim().min(1, 'Required'),
      })
  const form = useFormAction(schema, async (values) => {
    const input = {
      name: values.name,
      issuer: values.issuer,
      client_id: values.client_id,
      domains: values.domains,
      ...(values.client_secret && { client_secret: values.client_secret }),
    }
    if (connection) await settingsApi.saveSso(connection.id, input)
    else await settingsApi.addSso(input)
    toast.add({
      title: connection ? 'Connection saved' : 'Connection added',
      description: 'Run a test sign-in to check it works.',
      type: 'success',
    })
    await onDone()
  })

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onInput={(event) =>
        form.clearField((event.target as HTMLInputElement).name)
      }
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit(formValues(event.currentTarget))
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {connection ? `Edit ${connection.name}` : 'Add a connection'}
        </DialogTitle>
        <DialogDescription>
          The provider is checked before saving. Changing its issuer, client ID
          or secret needs a new test sign-in.
        </DialogDescription>
      </DialogHeader>
      <FormError message={form.error} />
      <TextField
        name="name"
        label="Name on the sign-in button"
        placeholder="Acme SSO"
        defaultValue={connection?.name}
        autoFocus
        error={form.fields.name}
      />
      <TextField
        name="issuer"
        label="Issuer URL"
        type="url"
        placeholder="https://acme.okta.com"
        defaultValue={connection?.issuer}
        error={form.fields.issuer}
      />
      <TextField
        name="client_id"
        label="Client ID"
        defaultValue={connection?.client_id}
        autoComplete="off"
        error={form.fields.client_id}
      />
      <TextField
        name="client_secret"
        label="Client secret"
        type="password"
        autoComplete="new-password"
        placeholder={
          connection ? 'Leave empty to keep the current secret' : undefined
        }
        error={form.fields.client_secret}
      />
      <DomainsField
        defaultValue={connection?.domains.join('\n')}
        error={form.fields.domains}
      />
      <DialogFooter>
        <SubmitButton pending={form.pending}>
          {connection ? 'Save' : 'Add connection'}
        </SubmitButton>
      </DialogFooter>
    </form>
  )
}

function DomainsField({
  defaultValue,
  error,
}: {
  defaultValue?: string
  error?: string
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor="sso-domains">Email domains</FieldLabel>
      <Textarea
        id="sso-domains"
        name="domains"
        rows={2}
        placeholder="acme.com"
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
      />
      <FieldDescription>
        People with these email domains sign in through this provider. One per
        line.
      </FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}
