/**
 * The role editor (org.roles.manage): custom roles built from the permission
 * catalog. Built-in roles are locked (the migrate job owns them); to change
 * one, duplicate it.
 *
 *   tenant role   tenant permissions only; given inside one tenant
 *   org role      org and tenant permissions; applies in every tenant
 *
 * Rules:
 *   - every permission on the role must be one the editor holds, and so must
 *     every permission it had (nobody edits a role above their own access);
 *   - a permission's `requires` comes with it (projects.edit brings projects.view);
 *   - a role in use (people, or open invitations) cannot be deleted.
 * Edits apply to everyone with the role on their next request.
 */

import { and, asc, count, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { isUniqueViolation, withApp } from '#/db/db';
import { invitations, modules, permissions, profiles, rolePermissions, roles, tenantMemberships } from '#/db/schema';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import type { AuthContext } from '#/modules/iam';

import { holdsAll, permissionKeysByRole } from './roles';
import type { createRoleSchema, updateRoleSchema } from './tenancy.validators';

type Scope = 'org' | 'tenant';

export interface RoleDetail {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  scope: Scope;
  is_system: boolean;
  permissions: string[];
  /** Who would be affected by an edit, and what blocks deleting it. */
  usage: { people: number; invitations: number };
}

export interface RoleCatalog {
  modules: { key: string; label: string }[];
  permissions: { key: string; module_key: string; scope: Scope; label: string; requires: string | null }[];
}

const NAME_TAKEN = () => new AppError('VALIDATION', 'Some fields are invalid.', { name: 'A role with this name already exists.' });

// ─── Reading ─────────────────────────────────────────────────────

async function usageByRole(tx: Tx, roleIds: string[]): Promise<Map<string, { people: number; invitations: number }>> {
  const usage = new Map(roleIds.map((id) => [id, { people: 0, invitations: 0 }]));
  if (roleIds.length === 0) return usage;
  const members = await tx
    .select({ roleId: tenantMemberships.role_id, n: count() })
    .from(tenantMemberships)
    .where(and(inArray(tenantMemberships.role_id, roleIds), isNull(tenantMemberships.deleted_at)))
    .groupBy(tenantMemberships.role_id);
  const orgPeople = await tx
    .select({ roleId: profiles.org_role_id, n: count() })
    .from(profiles)
    .where(and(isNotNull(profiles.org_role_id), inArray(profiles.org_role_id, roleIds), isNull(profiles.deleted_at)))
    .groupBy(profiles.org_role_id);
  const invites = await tx
    .select({ roleId: invitations.role_id, n: count() })
    .from(invitations)
    .where(
      and(
        inArray(invitations.role_id, roleIds),
        eq(invitations.status, 'pending'),
        gt(invitations.expires_at, sql`now()`),
        isNull(invitations.deleted_at),
      ),
    )
    .groupBy(invitations.role_id);
  for (const { roleId, n } of [...members, ...orgPeople]) if (roleId) usage.get(roleId)!.people += n;
  for (const { roleId, n } of invites) usage.get(roleId)!.invitations += n;
  return usage;
}

/** Every live org-wide role with its permissions and usage, plus the catalog to edit them with. */
export async function listRoles(): Promise<{ roles: RoleDetail[]; catalog: RoleCatalog }> {
  return withApp(async (tx) => {
    const rows = await tx
      .select({
        id: roles.id,
        key: roles.key,
        name: roles.name,
        description: roles.description,
        scope: roles.scope,
        is_system: roles.is_system,
      })
      .from(roles)
      .where(and(isNull(roles.deleted_at), isNull(roles.tenant_id)));
    const ids = rows.map((r) => r.id);
    const keys = await permissionKeysByRole(tx, ids);
    const usage = await usageByRole(tx, ids);
    const catalog: RoleCatalog = {
      modules: await tx.select({ key: modules.key, label: modules.label }).from(modules).orderBy(asc(modules.sort_order)),
      permissions: (
        await tx
          .select({
            key: permissions.key,
            module_key: permissions.module_key,
            scope: permissions.scope,
            label: permissions.label,
            requires: permissions.requires,
          })
          .from(permissions)
          .orderBy(asc(permissions.sort_order))
      ).map((p) => ({ ...p, scope: p.scope as Scope })),
    };
    const detailed = rows.map((r) => ({
      ...r,
      scope: r.scope as Scope,
      permissions: keys.get(r.id) ?? [],
      usage: usage.get(r.id)!,
    }));
    // Org roles first; within a scope built-in before custom, most access first.
    const rank = (r: RoleDetail) => [r.scope === 'org' ? 0 : 1, r.is_system ? 0 : 1, -r.permissions.length] as const;
    detailed.sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.name.localeCompare(b.name);
    });
    return { roles: detailed, catalog };
  });
}

// ─── Checking a permission set ───────────────────────────────────

/**
 * The permission set a role will really have: known keys only, the right
 * scope, and every `requires` added. Throws on anything the editor may not give.
 */
async function resolvePermissions(tx: Tx, scope: Scope, requested: string[], held: Set<string>): Promise<string[]> {
  const catalog = await tx
    .select({ key: permissions.key, scope: permissions.scope, requires: permissions.requires })
    .from(permissions);
  const byKey = new Map(catalog.map((p) => [p.key, p]));

  const result = new Set<string>();
  const add = (key: string) => {
    if (result.has(key)) return;
    const permission = byKey.get(key);
    if (!permission) throw new AppError('VALIDATION', 'Some fields are invalid.', { permissions: `Unknown permission: ${key}` });
    // Org roles apply in every tenant, so they may carry tenant permissions too.
    if (scope === 'tenant' && permission.scope !== 'tenant') {
      throw new AppError('VALIDATION', 'Some fields are invalid.', { permissions: 'A tenant role cannot include organization permissions.' });
    }
    result.add(key);
    if (permission.requires) add(permission.requires);
  };
  requested.forEach(add);

  if (result.size === 0) {
    throw new AppError('VALIDATION', 'Some fields are invalid.', { permissions: 'Choose at least one permission.' });
  }
  if (!holdsAll([...result], held)) {
    throw new AppError('FORBIDDEN', 'You cannot give a role permissions you do not have yourself.');
  }
  return [...result];
}

async function nameTaken(tx: Tx, name: string, exceptId?: string): Promise<boolean> {
  const rows = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        sql`lower(${roles.name}) = lower(${name})`,
        isNull(roles.deleted_at),
        isNull(roles.tenant_id),
        exceptId ? sql`${roles.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** A custom role, locked for the rest of the transaction, that the editor may change. */
async function customRoleToChange(tx: Tx, id: string, held: Set<string>) {
  const [role] = await tx
    .select({ id: roles.id, name: roles.name, description: roles.description, scope: roles.scope, isSystem: roles.is_system })
    .from(roles)
    .where(and(eq(roles.id, id), isNull(roles.deleted_at), isNull(roles.tenant_id)))
    .for('update');
  if (!role) throw new AppError('NOT_FOUND', 'Role not found.');
  if (role.isSystem) throw new AppError('FORBIDDEN', 'Built-in roles cannot be changed. Duplicate it to make your own.');
  const current = (await permissionKeysByRole(tx, [id])).get(id) ?? [];
  if (!holdsAll(current, held)) {
    throw new AppError('FORBIDDEN', 'This role has permissions you do not have, so you cannot change it.');
  }
  return { ...role, scope: role.scope as Scope, current };
}

async function withNameCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // Two people saving the same name at the same moment: one wins.
    if (isUniqueViolation(err, 'roles_name_live')) throw NAME_TAKEN();
    throw err;
  }
}

// ─── Writing ─────────────────────────────────────────────────────

export async function createRole(
  auth: AuthContext,
  held: Set<string>,
  input: z.infer<typeof createRoleSchema>,
  meta: RequestMeta,
): Promise<{ id: string }> {
  return withNameCheck(() =>
    withApp(async (tx) => {
      if (await nameTaken(tx, input.name)) throw NAME_TAKEN();
      const keys = await resolvePermissions(tx, input.scope, input.permissions, held);
      const [role] = await tx
        .insert(roles)
        .values({ name: input.name, description: input.description || null, scope: input.scope, created_by: auth.userId })
        .returning({ id: roles.id });
      await tx.insert(rolePermissions).values(keys.map((key) => ({ role_id: role!.id, permission_key: key })));
      await recordAudit(
        tx,
        { action: 'role.created', actorUserId: auth.userId, targetType: 'role', targetId: role!.id, changes: { name: input.name, scope: input.scope, permissions: keys.sort() } },
        meta,
      );
      return role!;
    }),
  );
}

export async function updateRole(
  auth: AuthContext,
  id: string,
  held: Set<string>,
  input: z.infer<typeof updateRoleSchema>,
  meta: RequestMeta,
) {
  await withNameCheck(() =>
    withApp(async (tx) => {
      const role = await customRoleToChange(tx, id, held);
      const changes: Record<string, unknown> = {};

      if (input.name !== undefined && input.name !== role.name) {
        if (await nameTaken(tx, input.name, id)) throw NAME_TAKEN();
        changes.name = { from: role.name, to: input.name };
      }
      // An empty description clears it.
      const description = input.description === undefined ? role.description : input.description || null;
      if (description !== role.description) changes.description = { from: role.description, to: description };
      if (changes.name || changes.description) {
        await tx.update(roles).set({ name: input.name ?? role.name, description }).where(eq(roles.id, id));
      }

      if (input.permissions !== undefined) {
        const next = await resolvePermissions(tx, role.scope, input.permissions, held);
        const added = next.filter((k) => !role.current.includes(k));
        const removed = role.current.filter((k) => !next.includes(k));
        if (removed.length > 0) {
          await tx.delete(rolePermissions).where(and(eq(rolePermissions.role_id, id), inArray(rolePermissions.permission_key, removed)));
        }
        if (added.length > 0) {
          await tx.insert(rolePermissions).values(added.map((key) => ({ role_id: id, permission_key: key })));
        }
        if (added.length > 0 || removed.length > 0) changes.permissions = { added: added.sort(), removed: removed.sort() };
      }

      if (Object.keys(changes).length > 0) {
        await recordAudit(tx, { action: 'role.updated', actorUserId: auth.userId, targetType: 'role', targetId: id, changes }, meta);
      }
    }),
  );
}

export async function deleteRole(auth: AuthContext, id: string, held: Set<string>, meta: RequestMeta) {
  await withApp(async (tx) => {
    // The row lock makes anyone assigning this role right now wait, so the
    // usage count below cannot miss them.
    const role = await customRoleToChange(tx, id, held);
    const usage = (await usageByRole(tx, [id])).get(id)!;
    if (usage.people > 0 || usage.invitations > 0) {
      const parts = [
        usage.people > 0 && `${usage.people} ${usage.people === 1 ? 'person has' : 'people have'} it`,
        usage.invitations > 0 && `${usage.invitations} open ${usage.invitations === 1 ? 'invitation uses' : 'invitations use'} it`,
      ].filter(Boolean);
      throw new AppError('CONFLICT', `This role is still in use: ${parts.join(' and ')}. Change their role or revoke the invitations first.`);
    }
    // Expired invitations that still point at it can never be accepted; close them.
    await tx
      .update(invitations)
      .set({ status: 'revoked' })
      .where(and(eq(invitations.role_id, id), eq(invitations.status, 'pending')));
    await tx.update(roles).set({ deleted_at: new Date() }).where(eq(roles.id, id));
    await recordAudit(tx, { action: 'role.deleted', actorUserId: auth.userId, targetType: 'role', targetId: id, changes: { name: role.name } }, meta);
  });
}
