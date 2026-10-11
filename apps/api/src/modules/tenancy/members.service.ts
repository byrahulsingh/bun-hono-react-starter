/**
 * The people of one tenant: who they are, which role they have there, and the
 * roles a manager may hand out.
 *
 *   tenant members   a tenant_memberships row; managed here
 *   org people       an org role (owner, admin): every tenant, managed at org level
 *
 * Rules for changing someone: not yourself, and nobody touches a person whose
 * role (current or new) carries a permission they do not hold themselves.
 * Changes apply on the person's next request: permissions are read per request.
 */

import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
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

export interface Member {
  user_id: string;
  name: string;
  email: string;
  role: { id: string; name: string };
  /** 'org': access to every tenant through an org role, so not managed here. */
  access: 'tenant' | 'org';
  since: Date;
  /** False when the account is deactivated: listed, but cannot sign in. */
  active: boolean;
}

/** Everyone who can open this tenant. Org people first, then members, by name. */
export async function listMembers(tenantId: string): Promise<Member[]> {
  // As iam_service: the emails live with the logins, in schema iam.
  return withIam(async (tx) => {
    const orgPeople = await tx
      .select({ user_id: profiles.id, name: profiles.name, role: { id: roles.id, name: roles.name }, since: profiles.created_at })
      .from(profiles)
      .innerJoin(roles, eq(roles.id, profiles.org_role_id))
      .where(and(isNotNull(profiles.org_role_id), isNull(profiles.deleted_at)))
      .orderBy(asc(profiles.name));
    const members = await tx
      .select({ user_id: profiles.id, name: profiles.name, role: { id: roles.id, name: roles.name }, since: tenantMemberships.created_at })
      .from(tenantMemberships)
      .innerJoin(profiles, eq(profiles.id, tenantMemberships.user_id))
      .innerJoin(roles, eq(roles.id, tenantMemberships.role_id))
      .where(and(eq(tenantMemberships.tenant_id, tenantId), isNull(tenantMemberships.deleted_at), isNull(profiles.deleted_at)))
      .orderBy(asc(profiles.name));

    // Someone with an org role already sees every tenant; show them once.
    const orgIds = new Set(orgPeople.map((p) => p.user_id));
    const all = [
      ...orgPeople.map((p) => ({ ...p, access: 'org' as const })),
      ...members.filter((m) => !orgIds.has(m.user_id)).map((m) => ({ ...m, access: 'tenant' as const })),
    ];
    const accounts = await accountsFor(tx, all.map((p) => p.user_id));
    return all.flatMap((p) => {
      const account = accounts.get(p.user_id);
      return account ? [{ ...p, email: account.email, active: account.active }] : [];
    });
  });
}

/** Roles that can be given inside this tenant, most access first. */
export const tenantRoles = (tenantId: string, held: Set<string>) => assignableRoles('tenant', tenantId, held);

/** The live membership, locked, after the checks every change shares. */
async function membershipToChange(tx: Tx, auth: AuthContext, tenantId: string, userId: string, held: Set<string>) {
  if (userId === auth.userId) throw new AppError('FORBIDDEN', "You can't change your own access. Ask another manager.");
  const [membership] = await tx
    .select({ id: tenantMemberships.id, roleId: tenantMemberships.role_id })
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.tenant_id, tenantId), eq(tenantMemberships.user_id, userId), isNull(tenantMemberships.deleted_at)))
    .for('update');
  if (!membership) throw new AppError('NOT_FOUND', 'This person is not a member of this tenant.');
  if (!(await canHandOut(tx, membership.roleId, held))) {
    throw new AppError('FORBIDDEN', 'This person has access you do not have, so you cannot change it.');
  }
  return membership;
}

export async function changeMemberRole(
  auth: AuthContext,
  tenantId: string,
  userId: string,
  held: Set<string>,
  input: z.infer<typeof changeRoleSchema>,
  meta: RequestMeta,
) {
  await withApp(async (tx) => {
    const membership = await membershipToChange(tx, auth, tenantId, userId, held);
    const [role] = await tx
      .select({ id: roles.id, name: roles.name, scope: roles.scope, tenantId: roles.tenant_id })
      .from(roles)
      .where(and(eq(roles.id, input.role_id), isNull(roles.deleted_at)))
      .for('share'); // a concurrent delete of this role waits, then sees the member
    if (!role || role.scope !== 'tenant' || (role.tenantId && role.tenantId !== tenantId)) {
      throw new AppError('VALIDATION', 'Some fields are invalid.', { role_id: 'Choose a tenant role' });
    }
    if (role.id === membership.roleId) return;
    if (!(await canHandOut(tx, role.id, held))) {
      throw new AppError('FORBIDDEN', 'You cannot give someone more access than you have.');
    }

    await tx.update(tenantMemberships).set({ role_id: role.id }).where(eq(tenantMemberships.id, membership.id));
    await recordAudit(
      tx,
      {
        action: 'membership.role_changed',
        actorUserId: auth.userId,
        tenantId,
        targetType: 'user',
        targetId: userId,
        changes: { from_role_id: membership.roleId, to_role_id: role.id, to_role: role.name },
      },
      meta,
    );
  });
}

export async function removeMember(auth: AuthContext, tenantId: string, userId: string, held: Set<string>, meta: RequestMeta) {
  await withApp(async (tx) => {
    const membership = await membershipToChange(tx, auth, tenantId, userId, held);
    await tx.update(tenantMemberships).set({ deleted_at: new Date() }).where(eq(tenantMemberships.id, membership.id));
    await recordAudit(
      tx,
      { action: 'membership.removed', actorUserId: auth.userId, tenantId, targetType: 'user', targetId: userId, changes: { role_id: membership.roleId } },
      meta,
    );
  });
}
