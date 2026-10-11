/**
 * What may this person do, here? The code checks permission keys, never role
 * names.
 *
 *   org role (owner / admin)  its permissions apply in every tenant
 *   tenant membership         its role's permissions, in that tenant only
 *   archived tenant           only the *.view permissions remain
 *
 * A tenant the person cannot see at all answers 404, not 403, so its existence
 * is not revealed.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { Tx } from '#/db/db';
import { withApp } from '#/db/db';
import { profiles, rolePermissions, roles, tenantMemberships, tenants } from '#/db/schema';
import { AppError } from '#/libs/errors';
import type { AppEnv } from '#/types/app.types';

import type { PermissionKey } from './tenancy.catalog';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Access {
  permissions: Set<string>;
  /** False when the tenant does not exist or this person has no access to it. */
  tenantVisible: boolean;
}

async function rolePermissionKeys(tx: Tx, roleId: string): Promise<string[]> {
  const rows = await tx
    .select({ key: rolePermissions.permission_key })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.role_id))
    .where(and(eq(rolePermissions.role_id, roleId), isNull(roles.deleted_at)));
  return rows.map((r) => r.key);
}

/** Permissions of `userId` at org level (`tenantId` null) or inside one tenant. */
export async function permissionsFor(tx: Tx, userId: string, tenantId: string | null): Promise<Access> {
  const [profile] = await tx
    .select({ orgRoleId: profiles.org_role_id })
    .from(profiles)
    .where(and(eq(profiles.id, userId), isNull(profiles.deleted_at)));
  if (!profile) return { permissions: new Set(), tenantVisible: false };

  const keys = new Set(profile.orgRoleId ? await rolePermissionKeys(tx, profile.orgRoleId) : []);
  if (tenantId === null) return { permissions: keys, tenantVisible: false };

  if (!UUID.test(tenantId)) return { permissions: new Set(), tenantVisible: false };
  const [tenant] = await tx
    .select({ status: tenants.status })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), isNull(tenants.deleted_at)));
  if (!tenant) return { permissions: new Set(), tenantVisible: false };

  const [membership] = await tx
    .select({ roleId: tenantMemberships.role_id })
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.tenant_id, tenantId),
        eq(tenantMemberships.user_id, userId),
        isNull(tenantMemberships.deleted_at),
      ),
    );
  if (membership) for (const key of await rolePermissionKeys(tx, membership.roleId)) keys.add(key);

  const visible = Boolean(profile.orgRoleId) || Boolean(membership);
  if (!visible) return { permissions: new Set(), tenantVisible: false };

  if (tenant.status === 'archived') {
    for (const key of keys) if (!key.endsWith('.view') && !key.startsWith('org.')) keys.delete(key);
  }
  return { permissions: keys, tenantVisible: true };
}

async function loadAccess(c: Context<AppEnv>): Promise<Access> {
  const tenantId = c.req.param('tenantId') ?? null;
  const access = await withApp((tx) => permissionsFor(tx, c.get('auth').userId, tenantId));
  if (tenantId !== null && !access.tenantVisible) throw new AppError('NOT_FOUND', 'Tenant not found.');
  c.set('permissions', access.permissions);
  return access;
}

/**
 * Route guard. On routes under `/t/:tenantId` the check is inside that tenant;
 * elsewhere it is at org level. Use after requireAuth.
 */
export function requirePermission(key: PermissionKey) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const access = await loadAccess(c);
    if (!access.permissions.has(key)) throw new AppError('FORBIDDEN', "You don't have permission to do this.");
    await next();
  });
}

/** Only that the caller can see the tenant in the URL, whatever their permissions. */
export const requireTenantAccess = createMiddleware<AppEnv>(async (c, next) => {
  await loadAccess(c);
  await next();
});
