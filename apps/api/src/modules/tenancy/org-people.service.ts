/**
 * The organization's People directory (org.users.manage): everyone with an
 * account here, where they have access, and the actions that work on the
 * account itself rather than one tenant.
 *
 *   deactivate / reactivate   sign-in off or on; roles and memberships are kept,
 *                             so reactivating restores exactly what they had
 *   send reset link           emails them a password reset link
 *   add to tenant             a membership directly, no invitation round-trip
 *   reset two-factor          lost phone and recovery codes: 2FA off, signed out everywhere
 *
 * Same rules as everywhere: not on yourself, never on someone with more access
 * than you, and the organization keeps at least one active owner.
 */

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { isUniqueViolation, withApp, withIam } from '#/db/db';
import { profiles, roles, tenantMemberships, tenants } from '#/db/schema';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import type { AuthContext } from '#/modules/iam';
import { accountsFor, resetTwoFactor, sendPasswordResetLink, setAccountActive, twoFactorUsersAmong } from '#/modules/iam';
import { enqueueEmail } from '#/modules/notifications';

import { assertAnotherOwner, ORG_ROLES_LOCK_ID } from './org.service';
import { canHandOut } from './roles';
import { addedToTenantEmail, twoFactorResetEmail } from './tenancy.emails';
import type { addToTenantSchema } from './tenancy.validators';

export interface OrgPerson {
  user_id: string;
  name: string;
  email: string;
  active: boolean;
  last_login_at: Date | null;
  /** Signs in with an authenticator app code as well as the password. */
  two_factor: boolean;
  /** Owner, admin or a custom org role: access to every tenant. */
  org_role: { id: string; key: string | null; name: string } | null;
  /** Their own memberships (archived tenants included, marked). */
  tenants: { id: string; name: string; archived: boolean; role: { id: string; name: string } }[];
}

export async function listOrgPeople(): Promise<{ people: OrgPerson[]; tenants: { id: string; name: string }[] }> {
  // As iam_service: emails, sign-in times and status live with the logins.
  return withIam(async (tx) => {
    const people = await tx
      .select({ user_id: profiles.id, name: profiles.name, org_role: { id: roles.id, key: roles.key, name: roles.name } })
      .from(profiles)
      .leftJoin(roles, eq(roles.id, profiles.org_role_id))
      .where(isNull(profiles.deleted_at))
      .orderBy(asc(sql`lower(${profiles.name})`));
    const memberships = await tx
      .select({
        user_id: tenantMemberships.user_id,
        id: tenants.id,
        name: tenants.name,
        status: tenants.status,
        role: { id: roles.id, name: roles.name },
      })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenant_id))
      .innerJoin(roles, eq(roles.id, tenantMemberships.role_id))
      .where(and(isNull(tenantMemberships.deleted_at), isNull(tenants.deleted_at)))
      .orderBy(asc(sql`lower(${tenants.name})`));
    const activeTenants = await tx
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.is_active, true))
      .orderBy(asc(sql`lower(${tenants.name})`));
    const accounts = await accountsFor(tx, people.map((p) => p.user_id));
    const withTwoFactor = await twoFactorUsersAmong(tx, people.map((p) => p.user_id));

    return {
      people: people.flatMap((p) => {
        const account = accounts.get(p.user_id);
        if (!account) return [];
        return [
          {
            ...p,
            // A left join gives an object of nulls when there is no org role.
            org_role: p.org_role?.id ? p.org_role : null,
            ...account,
            two_factor: withTwoFactor.has(p.user_id),
            tenants: memberships
              .filter((m) => m.user_id === p.user_id)
              .map((m) => ({ id: m.id, name: m.name, archived: m.status === 'archived', role: m.role })),
          },
        ];
      }),
      tenants: activeTenants,
    };
  });
}

/** The person's org role, if any, after the checks every account action shares. */
async function personToChange(tx: Tx, auth: AuthContext, userId: string, held: Set<string>) {
  if (userId === auth.userId) throw new AppError('FORBIDDEN', "You can't do this to your own account.");
  const [person] = await tx
    .select({ name: profiles.name, roleId: roles.id, roleKey: roles.key })
    .from(profiles)
    .leftJoin(roles, eq(roles.id, profiles.org_role_id))
    .where(and(eq(profiles.id, userId), isNull(profiles.deleted_at)));
  if (!person) throw new AppError('NOT_FOUND', 'This person does not exist.');
  if (person.roleId && !(await canHandOut(tx, person.roleId, held))) {
    throw new AppError('FORBIDDEN', 'This person has access you do not have, so you cannot change their account.');
  }
  return person;
}

export async function setPersonActive(auth: AuthContext, userId: string, held: Set<string>, active: boolean, meta: RequestMeta) {
  // As iam_service: the account status is a login matter.
  await withIam(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ORG_ROLES_LOCK_ID})`);
    const person = await personToChange(tx, auth, userId, held);
    if (!active && person.roleKey === 'owner') await assertAnotherOwner(tx, userId, true);
    if (!(await setAccountActive(tx, userId, active))) return;
    await recordAudit(
      tx,
      { action: active ? 'user.reactivated' : 'user.deactivated', actorUserId: auth.userId, targetType: 'user', targetId: userId },
      meta,
    );
  });
}

export async function sendResetLink(auth: AuthContext, userId: string, held: Set<string>, meta: RequestMeta) {
  await withIam(async (tx) => {
    await personToChange(tx, auth, userId, held);
    await sendPasswordResetLink(tx, userId);
    await recordAudit(tx, { action: 'auth.password_reset_sent', actorUserId: auth.userId, targetType: 'user', targetId: userId }, meta);
  });
}

/**
 * For someone who lost their phone and their recovery codes. They are signed
 * out everywhere and told by email; their password still works, and they set
 * two-factor up again (at once, if the organization requires it).
 */
export async function resetPersonTwoFactor(auth: AuthContext, userId: string, held: Set<string>, meta: RequestMeta) {
  await withIam(async (tx) => {
    await personToChange(tx, auth, userId, held);
    if (!(await resetTwoFactor(tx, userId))) {
      throw new AppError('CONFLICT', 'This person does not have two-factor sign-in on.');
    }
    const [admin] = await tx.select({ name: profiles.name }).from(profiles).where(eq(profiles.id, auth.userId));
    const account = (await accountsFor(tx, [userId])).get(userId)!;
    await enqueueEmail(tx, twoFactorResetEmail({ to: account.email, adminName: admin?.name ?? 'An administrator' }));
    await recordAudit(tx, { action: 'user.two_factor_reset', actorUserId: auth.userId, targetType: 'user', targetId: userId }, meta);
  });
}

/** A membership straight away (they are told by email), for someone who already has an account. */
export async function addToTenant(
  auth: AuthContext,
  userId: string,
  held: Set<string>,
  input: z.infer<typeof addToTenantSchema>,
  meta: RequestMeta,
) {
  const account = (await withIam((tx) => accountsFor(tx, [userId]))).get(userId);
  if (!account) throw new AppError('NOT_FOUND', 'This person does not exist.');
  if (!account.active) throw new AppError('CONFLICT', 'This account is deactivated. Reactivate it first.');

  try {
    await addMembership(auth, userId, held, input, meta, account.email);
  } catch (err) {
    // Added by someone else at the same moment.
    if (isUniqueViolation(err, 'tenant_memberships_live')) {
      throw new AppError('VALIDATION', 'Some fields are invalid.', { tenant_id: 'Already a member of this tenant' });
    }
    throw err;
  }
}

async function addMembership(
  auth: AuthContext,
  userId: string,
  held: Set<string>,
  input: z.infer<typeof addToTenantSchema>,
  meta: RequestMeta,
  email: string,
) {
  await withApp(async (tx) => {
    const [person] = await tx
      .select({ name: profiles.name, orgRoleId: profiles.org_role_id })
      .from(profiles)
      .where(and(eq(profiles.id, userId), isNull(profiles.deleted_at)));
    if (!person) throw new AppError('NOT_FOUND', 'This person does not exist.');
    if (person.orgRoleId) {
      throw new AppError('CONFLICT', 'They already see every tenant through their organization role.');
    }
    const [tenant] = await tx
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(and(eq(tenants.id, input.tenant_id), eq(tenants.is_active, true)));
    if (!tenant) throw new AppError('VALIDATION', 'Some fields are invalid.', { tenant_id: 'Choose an active tenant' });
    const [existing] = await tx
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenant_id, tenant.id), eq(tenantMemberships.user_id, userId), isNull(tenantMemberships.deleted_at)));
    if (existing) throw new AppError('VALIDATION', 'Some fields are invalid.', { tenant_id: 'Already a member of this tenant' });

    const [role] = await tx
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(
        and(
          eq(roles.id, input.role_id),
          eq(roles.scope, 'tenant'),
          isNull(roles.deleted_at),
          or(isNull(roles.tenant_id), eq(roles.tenant_id, tenant.id)),
        ),
      )
      .for('share'); // a concurrent delete of this role waits, then sees the member
    if (!role) throw new AppError('VALIDATION', 'Some fields are invalid.', { role_id: 'Choose a tenant role' });
    if (!(await canHandOut(tx, role.id, held))) {
      throw new AppError('FORBIDDEN', 'You cannot give someone more access than you have.');
    }

    await tx.insert(tenantMemberships).values({ tenant_id: tenant.id, user_id: userId, role_id: role.id, created_by: auth.userId });
    const [adder] = await tx.select({ name: profiles.name }).from(profiles).where(eq(profiles.id, auth.userId));
    await enqueueEmail(tx, addedToTenantEmail({ to: email, adderName: adder?.name ?? 'An administrator', tenantName: tenant.name, roleName: role.name }));
    await recordAudit(
      tx,
      { action: 'membership.added', actorUserId: auth.userId, tenantId: tenant.id, targetType: 'user', targetId: userId, changes: { role_id: role.id, role: role.name } },
      meta,
    );
  });
}
