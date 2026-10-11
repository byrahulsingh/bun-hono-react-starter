/**
 * Role helpers shared by everything that hands out roles (tenant members,
 * org admins, invitations). The rule they serve: nobody gives or changes
 * access beyond what they hold themselves.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import type { Tx } from '#/db/db';
import { withApp } from '#/db/db';
import { rolePermissions, roles } from '#/db/schema';

/** Permission keys of each role id (every id is in the map, even with none). */
export async function permissionKeysByRole(tx: Tx, roleIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(roleIds.map((id) => [id, []]));
  if (roleIds.length === 0) return map;
  const rows = await tx
    .select({ roleId: rolePermissions.role_id, key: rolePermissions.permission_key })
    .from(rolePermissions)
    .where(inArray(rolePermissions.role_id, roleIds));
  for (const { roleId, key } of rows) map.get(roleId)?.push(key);
  return map;
}

export const holdsAll = (keys: string[], held: Set<string>) => keys.every((k) => held.has(k));

/** True when `held` covers every permission of the role. */
export async function canHandOut(tx: Tx, roleId: string, held: Set<string>): Promise<boolean> {
  const keys = await permissionKeysByRole(tx, [roleId]);
  return holdsAll(keys.get(roleId) ?? [], held);
}

export interface AssignableRole {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  /** False when the role has a permission the caller lacks: they cannot hand it out. */
  assignable: boolean;
}

/** Roles of one scope (tenant roles: those usable in `tenantId`), most access first. */
export async function assignableRoles(
  scope: 'org' | 'tenant',
  tenantId: string | null,
  held: Set<string>,
): Promise<AssignableRole[]> {
  return withApp(async (tx) => {
    const rows = await tx
      .select({ id: roles.id, key: roles.key, name: roles.name, description: roles.description })
      .from(roles)
      .where(
        and(
          eq(roles.scope, scope),
          isNull(roles.deleted_at),
          tenantId ? or(isNull(roles.tenant_id), eq(roles.tenant_id, tenantId)) : isNull(roles.tenant_id),
        ),
      );
    const keys = await permissionKeysByRole(tx, rows.map((r) => r.id));
    return rows
      .map((r) => ({ ...r, size: keys.get(r.id)?.length ?? 0, assignable: holdsAll(keys.get(r.id) ?? [], held) }))
      .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
      .map(({ size: _size, ...role }) => role);
  });
}
