/**
 * Audit entries as sentences: "Asha renamed tenant Beta to Beta Clients".
 * One line per action the API writes (grep `action: '` in apps/api); an
 * action this file does not know yet still shows, as its raw name.
 */

import type { AuditEntry, AuditRefs } from '#/lib/api/audit'
import { PROJECT_STATUS_LABELS } from '#/lib/api/projects'

export interface DescribedEntry {
  /** Who did it: a name, "System", or "Someone" (a failed sign-in). */
  actor: string
  /** What they did, written to follow the actor's name. */
  text: string
  /** Security events worth a second look (failed sign-in, token reuse). */
  warning: boolean
}

type Describe = (e: AuditEntry, r: Helpers) => string

interface Helpers {
  user: (id: unknown) => string
  role: (id: unknown) => string
  tenant: (id: unknown) => string
  invitation: (id: unknown) => string
  str: (value: unknown) => string
}

const LOGOUT_SCOPES: Record<string, string> = {
  local: 'signed out',
  others: 'signed out of their other devices',
  global: 'signed out on every device',
}

const TWO_FACTOR_POLICIES: Record<string, string> = {
  off: 'nobody',
  org_roles: 'owners and admins',
  everyone: 'everyone',
}

const ACTIONS: Record<string, Describe> = {
  'setup.completed': () => 'set up the organization',

  'auth.login': (e, h) =>
    e.changes?.method === 'sso'
      ? `signed in with ${h.str(e.changes?.connection)}`
      : e.changes?.two_factor === 'recovery_code'
        ? 'signed in with a recovery code'
        : e.changes?.two_factor
          ? 'signed in with two-factor'
          : 'signed in',
  'auth.login_failed': (e, h) =>
    `failed to sign in as ${h.str(e.changes?.email)}`,
  'auth.logout': (e) => LOGOUT_SCOPES[String(e.changes?.scope)] ?? 'signed out',
  'auth.session_ended': () => 'signed out one of their devices',
  'auth.password_changed': () => 'changed their password',
  'auth.password_reset_requested': () => 'asked for a password reset link',
  'auth.password_reset': () => 'reset their password from an emailed link',
  'auth.password_reset_sent': (e, h) =>
    `sent ${h.user(e.target_id)} a password reset link`,
  'auth.token_revoked': () =>
    'had a session ended: an old sign-in token was used again, which can mean it was copied',

  'tenant.created': (e, h) => `created tenant ${h.str(e.changes?.name)}`,
  'tenant.renamed': (e, h) =>
    `renamed tenant ${h.str(e.changes?.from)} to ${h.str(e.changes?.to)}`,
  'tenant.archived': (e, h) => `archived tenant ${h.tenant(e.target_id)}`,
  'tenant.restored': (e, h) => `restored tenant ${h.tenant(e.target_id)}`,

  'project.created': (e, h) => `created project ${h.str(e.changes?.project)}`,
  'project.updated': (e, h) => {
    const changed = ['name', 'description', 'status'].filter(
      (key) => e.changes?.[key],
    )
    const status = e.changes?.status as { to?: unknown } | undefined
    if (changed.length === 1 && status)
      return `set project ${h.str(e.changes?.project)} to ${(PROJECT_STATUS_LABELS as Record<string, string>)[String(status.to)] ?? h.str(status.to)}`
    // Named as it was before, so a rename reads "changed the name of project Old".
    const name = e.changes?.name as { from?: unknown } | undefined
    const fields = changed.join(changed.length > 2 ? ', ' : ' and ')
    return `changed the ${fields} of project ${h.str(name ? name.from : e.changes?.project)}`
  },
  'project.deleted': (e, h) => `deleted project ${h.str(e.changes?.project)}`,

  'invitation.created': (e, h) =>
    `invited ${h.str(e.changes?.email)} as ${h.str(e.changes?.role)}`,
  'invitation.revoked': (e, h) =>
    `revoked the invitation for ${h.invitation(e.target_id)}`,
  'invitation.accepted': () => 'accepted an invitation',

  'membership.role_changed': (e, h) =>
    `changed ${h.user(e.target_id)}'s role to ${h.str(e.changes?.to_role) || h.role(e.changes?.to_role_id)}`,
  'membership.added': (e, h) =>
    `added ${h.user(e.target_id)} to the tenant as ${h.str(e.changes?.role) || h.role(e.changes?.role_id)}`,
  'membership.removed': (e, h) =>
    `removed ${h.user(e.target_id)} from the tenant`,

  'org_role.changed': (e, h) =>
    `changed ${h.user(e.target_id)}'s organization role to ${h.str(e.changes?.to_role) || h.role(e.changes?.to_role_id)}`,
  'org_role.removed': (e, h) =>
    `removed ${h.user(e.target_id)}'s organization role (${h.role(e.changes?.role_id)})`,

  'user.deactivated': (e, h) => `deactivated ${h.user(e.target_id)}'s account`,
  'user.reactivated': (e, h) => `reactivated ${h.user(e.target_id)}'s account`,

  'profile.updated': (e) => {
    const name = e.changes?.name as { from?: string; to?: string } | undefined
    return name
      ? `changed their name from ${name.from} to ${name.to}`
      : 'updated their profile'
  },

  'role.created': (e, h) => `created role ${h.str(e.changes?.name)}`,
  'role.updated': (e, h) => {
    const c = e.changes ?? {}
    const perms = c.permissions as
      { added: string[]; removed: string[] } | undefined
    const parts = [
      c.name && 'renamed it',
      c.description && 'changed its description',
      perms?.added.length &&
        `added ${perms.added.length} permission${perms.added.length === 1 ? '' : 's'}`,
      perms?.removed.length && `removed ${perms.removed.length}`,
    ].filter(Boolean)
    return `edited role ${h.role(e.target_id)}${parts.length ? `: ${parts.join(', ')}` : ''}`
  },
  'role.deleted': (e, h) => `deleted role ${h.str(e.changes?.name)}`,

  'auth.two_factor_enabled': () => 'turned on two-factor sign-in',
  'auth.two_factor_disabled': () => 'turned off two-factor sign-in',
  'auth.two_factor_failed': () => 'entered a wrong two-factor code',
  'auth.recovery_code_used': () => 'signed in with a recovery code',
  'auth.recovery_codes_regenerated': () => 'made new recovery codes',
  'auth.email_change_requested': (e, h) =>
    `asked to change their sign-in email to ${h.str(e.changes?.to)}`,
  'auth.email_changed': (e, h) =>
    `changed their sign-in email from ${h.str(e.changes?.from)} to ${h.str(e.changes?.to)}`,
  'auth.sso_linked': (e, h) =>
    `signed in with ${h.str(e.changes?.connection)} for the first time, as ${h.str(e.changes?.email)}`,
  'auth.sso_failed': (e, h) =>
    `failed to sign in with ${h.str(e.changes?.connection)}: ${h.str(e.changes?.reason)}`,
  'sso.connection_created': (e, h) =>
    `added single sign-on with ${h.str(e.changes?.name)} for ${((e.changes?.domains as string[] | undefined) ?? []).join(', ')}`,
  'sso.connection_updated': (e) => {
    const c = e.changes ?? {}
    const parts = [
      'name' in c && 'renamed it',
      'issuer' in c && 'changed the issuer',
      'client_id' in c && 'changed the client ID',
      'client_secret' in c && 'replaced the client secret',
      'domains' in c && 'changed the domains',
      'required' in c && 'it is no longer required until tested again',
    ].filter(Boolean)
    return `edited a single sign-on connection${parts.length ? `: ${parts.join(', ')}` : ''}`
  },
  'sso.connection_deleted': (e, h) =>
    `removed single sign-on with ${h.str(e.changes?.name)}`,
  'sso.required_changed': (e, h) =>
    e.changes?.to
      ? `required single sign-on with ${h.str(e.changes?.name)}`
      : `stopped requiring single sign-on with ${h.str(e.changes?.name)}`,
  'sso.tested': (e, h) =>
    e.changes?.ok
      ? `tested single sign-on with ${h.str(e.changes?.name)}: it worked`
      : `tested single sign-on with ${h.str(e.changes?.name)}: it failed`,
  'auth.sign_in_reported': () =>
    "signed out a device from a new-sign-in email: they said it wasn't them",
  'user.two_factor_reset': (e, h) =>
    `reset ${h.user(e.target_id)}'s two-factor sign-in`,
  'organization.two_factor_policy_changed': (e) =>
    `changed who must use two-factor sign-in to ${TWO_FACTOR_POLICIES[String(e.changes?.to)] ?? String(e.changes?.to)}`,

  'organization.renamed': (e, h) =>
    `renamed the organization from ${h.str(e.changes?.from)} to ${h.str(e.changes?.to)}`,
  'organization.onboarding_dismissed': () =>
    'hid the getting-started checklist',
  'branding.updated': (e) => {
    const c = e.changes ?? {}
    const change = (v: unknown) => (v as { to?: string | null } | undefined)?.to
    const parts = [
      'product_name' in c &&
        (change(c.product_name)
          ? `set the product name to ${change(c.product_name)}`
          : 'reset the product name'),
      'accent_color' in c &&
        (change(c.accent_color)
          ? `set the accent colour to ${change(c.accent_color)}`
          : 'reset the accent colour'),
      'logo' in c && `${String(c.logo)} the logo`,
      'icon' in c && `${String(c.icon)} the icon`,
    ].filter(Boolean)
    return parts.length ? parts.join(', ') : 'changed the branding'
  },
  'email.test_sent': (e, h) => `sent a test email to ${h.str(e.changes?.to)}`,
  'email.server_saved': (e, h) =>
    `set the mail server to ${h.str(e.changes?.host)}:${String(e.changes?.port ?? '')}, sending as ${h.str(e.changes?.from)}`,
  'email.server_removed': () => 'removed the mail server set in settings',

  'catalog.permissions_removed': (e) =>
    `removed permissions no longer in the app: ${((e.changes?.keys as string[] | undefined) ?? []).join(', ')}`,
}

const WARNINGS = new Set([
  'auth.login_failed',
  'auth.token_revoked',
  'auth.two_factor_failed',
  'auth.sign_in_reported',
  'auth.sso_failed',
])

export function describeEntry(
  entry: AuditEntry,
  refs: AuditRefs,
): DescribedEntry {
  const helpers: Helpers = {
    user: (id) => (typeof id === 'string' && refs.users[id]?.name) || 'someone',
    role: (id) => (typeof id === 'string' && refs.roles[id]) || 'a role',
    tenant: (id) => (typeof id === 'string' && refs.tenants[id]) || 'a tenant',
    invitation: (id) =>
      (typeof id === 'string' && refs.invitations[id]) || 'someone',
    str: (value) => (typeof value === 'string' ? value : ''),
  }
  const actor = entry.actor_user_id
    ? (refs.users[entry.actor_user_id]?.name ?? 'A deleted user')
    : entry.action === 'auth.login_failed'
      ? 'Someone'
      : 'System'
  const describe = ACTIONS[entry.action] as Describe | undefined
  return {
    actor,
    text: describe ? describe(entry, helpers) : entry.action,
    warning: WARNINGS.has(entry.action),
  }
}
