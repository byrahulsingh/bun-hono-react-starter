/**
 * Org admins: the people with an organization role (owner, admin, or a
 * custom org role), which gives access to every tenant. Invited through the
 * org invitations (invitations.service.ts, tenant_id null); changed here.
 *
 * Rules, on top of "nobody hands out more than they hold":
 *   - not on yourself;
 *   - the organization always keeps at least one owner.
 * Changes apply on the person's next request (permissions are read per request).
 */

import { and, asc, count, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { withApp, withIam } from '#/db/db';
import { profiles, roles, tenantMemberships } from '#/db/schema';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import type { AuthContext } from '#/modules/iam';
import { accountsFor } from '#/modules/iam';

import { assignableRoles, canHandOut } from './roles';
import type { changeRoleSchema } from './tenancy.validators';

/**
 * Any fixed number: serializes everything that can take an owner away (role
 * changes, deactivation), so the last-owner check cannot race.
 */
export const ORG_ROLES_LOCK_ID = 872_403;

export interface OrgMember {
  user_id: string;
  name: string;
  email: string;
  role: { id: string; key: string | null; name: string };
  /** Tenant memberships they also have: what they keep if the org role is removed. */
  tenant_count: number;
  last_login_at: Date | null;
  /** False when the account is deactivated. */
  active: boolean;
}

export async function listOrgMembers(): Promise<OrgMember[]> {
  // As iam_service: emails and sign-in times live with the logins.
  return withIam(async (tx) => {
    const rows = await tx
      .select({
        user_id: profiles.id,
        name: profiles.name,
        role: { id: roles.id, key: roles.key, name: roles.name },
        tenant_count: count(tenantMemberships.id),
      })
      .from(profiles)
      .innerJoin(roles, eq(roles.id, profiles.org_role_id))
      .leftJoin(tenantMemberships, and(eq(tenantMemberships.user_id, profiles.id), isNull(tenantMemberships.deleted_at)))
      .where(and(isNotNull(profiles.org_role_id), isNull(profiles.deleted_at)))
      .groupBy(profiles.id, roles.id)
      .orderBy(asc(profiles.name));
    const accounts = await accountsFor(tx, rows.map((r) => r.user_id));
    return rows.flatMap((r) => {
      const account = accounts.get(r.user_id);
      return account ? [{ ...r, ...account }] : [];
    });
  });
}

export const orgRoles = (held: Set<string>) => assignableRoles('org', null, held);

/** The person's org role, locked, after the checks every change shares. */
async function orgRoleToChange(tx: Tx, auth: AuthContext, userId: string, held: Set<string>) {
  if (userId === auth.userId) throw new AppError('FORBIDDEN', "You can't change your own organization role. Ask another owner or admin.");
  await tx.execute(sql`select pg_advisory_xact_lock(${ORG_ROLES_LOCK_ID})`);
  const [person] = await tx
    .select({ roleId: roles.id, roleKey: roles.key })
    .from(profiles)
    .innerJoin(roles, eq(roles.id, profiles.org_role_id))
    .where(and(eq(profiles.id, userId), isNull(profiles.deleted_at)));
  if (!person) throw new AppError('NOT_FOUND', 'This person has no organization role.');
  if (!(await canHandOut(tx, person.roleId, held))) {
    throw new AppError('FORBIDDEN', 'This person has access you do not have, so you cannot change it.');
  }
  return person;
}

/**
 * Refuses when `userId` is the last active owner (they are about to stop
 * being one). A deactivated owner does not count: they cannot sign in.
 * Callers hold ORG_ROLES_LOCK_ID. `canReadLogins`: the transaction runs as
 * iam_service and may read account status itself.
 */
export async function assertAnotherOwner(tx: Tx, userId: string, canReadLogins = false) {
  const others = await tx
    .select({ id: profiles.id })
    .from(profiles)
    .innerJoin(roles, eq(roles.id, profiles.org_role_id))
    .where(and(eq(roles.key, 'owner'), isNull(profiles.deleted_at), ne(profiles.id, userId)));
  const ids = others.map((o) => o.id);
  const accounts = canReadLogins ? await accountsFor(tx, ids) : await withIam((t) => accountsFor(t, ids));
  if (![...accounts.values()].some((a) => a.active)) {
    throw new AppError('CONFLICT', 'The organization must keep at least one active owner. Make someone else an owner first.');
  }
}

export async function changeOrgRole(
  auth: AuthContext,
  userId: string,
  held: Set<string>,
  input: z.infer<typeof changeRoleSchema>,
  meta: RequestMeta,
) {
  await withApp(async (tx) => {
    const person = await orgRoleToChange(tx, auth, userId, held);
    const [role] = await tx
      .select({ id: roles.id, key: roles.key, name: roles.name, scope: roles.scope, tenantId: roles.tenant_id })
      .from(roles)
      .where(and(eq(roles.id, input.role_id), isNull(roles.deleted_at)))
      .for('share'); // a concurrent delete of this role waits, then sees the person
    if (!role || role.scope !== 'org' || role.tenantId) {
      throw new AppError('VALIDATION', 'Some fields are invalid.', { role_id: 'Choose an organization role' });
    }
    if (role.id === person.roleId) return;
    if (!(await canHandOut(tx, role.id, held))) {
      throw new AppError('FORBIDDEN', 'You cannot give someone more access than you have.');
    }
    if (person.roleKey === 'owner' && role.key !== 'owner') await assertAnotherOwner(tx, userId);

    await tx.update(profiles).set({ org_role_id: role.id }).where(eq(profiles.id, userId));
    await recordAudit(
      tx,
      {
        action: 'org_role.changed',
        actorUserId: auth.userId,
        targetType: 'user',
        targetId: userId,
        changes: { from_role_id: person.roleId, to_role_id: role.id, to_role: role.name },
      },
      meta,
    );
  });
}

/** Takes the org role away. Their tenant memberships (if any) stay. */
export async function removeOrgRole(auth: AuthContext, userId: string, held: Set<string>, meta: RequestMeta) {
  await withApp(async (tx) => {
    const person = await orgRoleToChange(tx, auth, userId, held);
    if (person.roleKey === 'owner') await assertAnotherOwner(tx, userId);
    await tx.update(profiles).set({ org_role_id: null }).where(eq(profiles.id, userId));
    await recordAudit(
      tx,
      { action: 'org_role.removed', actorUserId: auth.userId, targetType: 'user', targetId: userId, changes: { role_id: person.roleId } },
      meta,
    );
  });
}
