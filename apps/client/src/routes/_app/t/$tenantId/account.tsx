import { createFileRoute, useRouter } from '@tanstack/react-router'
import { LogOutIcon, MonitorIcon, SmartphoneIcon } from 'lucide-react'
import { useState } from 'react'

import { EmailSection } from '#/components/account/email-section'
import { TwoFactorSection } from '#/components/account/two-factor-section'
import { FormSection } from '#/components/app/form-section'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { NewPasswordFields } from '#/components/auth/new-password-fields'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { toast } from '#/components/ui/toast'
import { ApiError } from '#/lib/api/api'
import type { SessionSummary } from '#/lib/api/auth'
import { accountApi, authApi } from '#/lib/api/auth'
import { changePasswordSchema, profileSchema } from '#/lib/auth/forms'
import { reloadMe, signOut, signOutOtherDevices } from '#/lib/auth/session'
import { useMe } from '#/lib/auth/store'
import { formValues, useFormAction } from '#/lib/use-form-action'
import { describeUserAgent } from '#/lib/user-agent'

/**
 * The signed-in person's own account. Under a tenant only so the sidebar
 * stays; nothing here depends on which tenant, and no permission is needed.
 */
export const Route = createFileRoute('/_app/t/$tenantId/account')({
  staticData: { title: 'Account' },
  loader: async () => {
    const [sessions, twoFactor, pendingEmail, methods] = await Promise.all([
      accountApi.sessions(),
      accountApi.twoFactor(),
      accountApi.pendingEmailChange(),
      accountApi.signInMethods(),
    ])
    return { sessions, twoFactor, pendingEmail, methods }
  },
  component: AccountPage,
})

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})
const formatDateTime = (iso: string) => dateTime.format(new Date(iso))

function errorMessage(err: unknown) {
  return err instanceof ApiError
    ? err.message
    : 'Something went wrong. Try again.'
}

function AccountPage() {
  const { sessions, twoFactor, pendingEmail, methods } = Route.useLoaderData()
  // Signed in only through single sign-on: no password to change or confirm with.
  const ssoOnly = !methods.password
  const router = useRouter()
  return (
    <div className="flex max-w-3xl flex-col gap-10 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">Account</h1>
        <p className="text-sm text-muted-foreground">
          Your details, sign-in email, password, two-factor sign-in and the
          devices you are signed in on.
        </p>
      </div>
      <ProfileSection />
      <EmailSection
        pending={pendingEmail}
        twoFactor={twoFactor.enabled}
        managedBy={ssoOnly ? methods.sso[0] : undefined}
        onChanged={() => router.invalidate()}
      />
      {ssoOnly ? (
        <SsoOnlySection names={methods.sso} />
      ) : (
        <>
          <PasswordSection />
          <TwoFactorSection
            status={twoFactor}
            onChanged={() => router.invalidate()}
          />
        </>
      )}
      <SessionsSection sessions={sessions} />
    </div>
  )
}

// ─── Profile ─────────────────────────────────────────────────────

function ProfileSection() {
  const me = useMe()
  const form = useFormAction(profileSchema, async (values) => {
    await accountApi.updateProfile(values)
    await reloadMe()
    toast.add({ title: 'Profile saved', type: 'success' })
  })
  return (
    <FormSection
      title="Profile"
      description="How you appear to others, in people lists and invitations."
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onInput={() => form.clearField('name')}
        onSubmit={(event) => {
          event.preventDefault()
          void form.submit(formValues(event.currentTarget))
        }}
      >
        <FormError message={form.error} />
        <TextField
          name="name"
          label="Name"
          autoComplete="name"
          defaultValue={me.user.name}
          error={form.fields.name}
        />
        <div>
          <SubmitButton pending={form.pending}>Save</SubmitButton>
        </div>
      </form>
    </FormSection>
  )
}

// ─── Password ────────────────────────────────────────────────────

function SsoOnlySection({ names }: { names: string[] }) {
  return (
    <FormSection
      title="How you sign in"
      description="Your password and two-factor sign-in are handled by your organization's identity provider."
    >
      <p className="text-sm">
        You sign in with {names.join(' or ') || 'single sign-on'}. This account
        has no password here.
      </p>
    </FormSection>
  )
}

function PasswordSection() {
  // A new key remounts the form: an empty form after a successful change.
  const [formKey, setFormKey] = useState(0)
  return (
    <FormSection
      title="Password"
      description="Changing it signs you out on every other device. You stay signed in here."
    >
      <PasswordForm key={formKey} onDone={() => setFormKey((k) => k + 1)} />
    </FormSection>
  )
}

function PasswordForm({ onDone }: { onDone: () => void }) {
  const me = useMe()
  const router = useRouter()
  const form = useFormAction(changePasswordSchema, async (values) => {
    await authApi.changePassword({
      current_password: values.current_password,
      new_password: values.password,
    })
    toast.add({
      title: 'Password changed',
      description: 'Your other devices were signed out.',
      type: 'success',
    })
    onDone()
    await router.invalidate()
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
      <FormError message={form.error} />
      {/* For password managers: which account this password belongs to. */}
      <input
        type="email"
        name="username"
        autoComplete="username"
        value={me.user.email}
        readOnly
        hidden
      />
      <TextField
        name="current_password"
        label="Current password"
        type="password"
        autoComplete="current-password"
        error={form.fields.current_password}
      />
      <NewPasswordFields errors={form.fields} label="New password" />
      <div>
        <SubmitButton pending={form.pending}>Change password</SubmitButton>
      </div>
    </form>
  )
}

// ─── Devices ─────────────────────────────────────────────────────

function SessionsSection({ sessions }: { sessions: SessionSummary[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const others = sessions.filter((s) => !s.current)

  async function act(key: string, run: () => Promise<unknown>, done: string) {
    if (busy) return
    setBusy(key)
    try {
      await run()
      toast.add({ title: done, type: 'success' })
      await router.invalidate()
    } catch (err) {
      toast.add({ title: errorMessage(err), type: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <FormSection
      title="Where you're signed in"
      description="Sign out any device you don't recognise, then change your password."
    >
      <div className="flex flex-col gap-4">
        <ul className="divide-y rounded-lg border">
          {sessions.map((s) => {
            const device = describeUserAgent(s.user_agent)
            const Icon = device.mobile ? SmartphoneIcon : MonitorIcon
            return (
              <li
                key={s.id}
                className="flex items-center gap-3 p-3"
                aria-busy={busy === s.id}
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Icon className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {device.label}
                    {s.current && (
                      <Badge variant="secondary">This device</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      s.ip,
                      `Signed in ${formatDateTime(s.created_at)}`,
                      !s.current &&
                        `Last active ${formatDateTime(s.last_active_at)}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                {s.current ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void signOut()}
                  >
                    <LogOutIcon aria-hidden="true" />
                    Sign out
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        s.id,
                        () => accountApi.endSession(s.id),
                        `Signed out of ${device.label}`,
                      )
                    }
                  >
                    Sign out
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
        {others.length > 0 && (
          <div>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void act(
                  'others',
                  signOutOtherDevices,
                  'Signed out of all other devices',
                )
              }
            >
              Sign out all other devices
            </Button>
          </div>
        )}
      </div>
    </FormSection>
  )
}
