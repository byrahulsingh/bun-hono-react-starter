/**
 * Copies the catalogs in code (lookup values, modules, permissions, built-in
 * roles) into the database. Runs in the migrate job after the migrations,
 * every time, so an upgrade that adds a status or a permission needs no
 * hand-written data migration.
 *
 *   lookups      upserted; rows removed from code are kept (rows may still use them)
 *   permissions  upserted; removed ones are deleted with their role ticks, and audited
 *   built-ins    upserted by key; their permissions set to exactly the catalog's
 *   custom roles untouched: a new permission arrives unticked
 */

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';

import type { Tx } from '#/db/db';
import {
  auditLogs,
  invitationStatuses,
  modules,
  permissions,
  projectStatuses,
  rolePermissions,
  roleScopes,
  roles,
  tenantStatuses,
  tokenTypes,
  userStatuses,
} from '#/db/schema';
import { logger } from '#/libs/logger';
import { TOKEN_TYPES, USER_STATUSES } from '#/modules/iam/iam.catalog';
import { PROJECT_STATUSES } from '#/modules/projects/projects.catalog';
import {
  BUILT_IN_ROLES,
  INVITATION_STATUSES,
  MODULES,
  PERMISSIONS,
  ROLE_SCOPES,
  TENANT_STATUSES,
} from '#/modules/tenancy/tenancy.catalog';

interface LookupRow {
  key: string;
  label: string;
  sort_order: number;
}

async function upsertLookup(tx: Tx, table: PgTable, rows: readonly LookupRow[]) {
  const { schema, name } = getTableConfig(table);
  const target = sql.raw(`"${schema ?? 'public'}"."${name}"`);
  for (const row of rows) {
    await tx.execute(sql`
      insert into ${target} (key, label, sort_order) values (${row.key}, ${row.label}, ${row.sort_order})
      on conflict (key) do update set label = excluded.label, sort_order = excluded.sort_order`);
  }
}

export async function syncCatalog(tx: Tx) {
  await upsertLookup(tx, userStatuses, USER_STATUSES);
  await upsertLookup(tx, tokenTypes, TOKEN_TYPES);
  await upsertLookup(tx, roleScopes, ROLE_SCOPES);
  await upsertLookup(tx, tenantStatuses, TENANT_STATUSES);
  await upsertLookup(tx, invitationStatuses, INVITATION_STATUSES);
  await upsertLookup(tx, modules, MODULES);
  await upsertLookup(tx, projectStatuses, PROJECT_STATUSES);

  // Permissions. `requires` points at other permissions, so insert them all
  // first and link them in a second pass.
  const catalogKeys = PERMISSIONS.map((p) => p.key);
  for (const [index, p] of PERMISSIONS.entries()) {
    const row = { key: p.key, module_key: p.module_key, action: p.action, scope: p.scope, label: p.label, sort_order: index };
    await tx
      .insert(permissions)
      .values({ ...row, requires: null })
      .onConflictDoUpdate({ target: permissions.key, set: row });
  }
  for (const p of PERMISSIONS) {
    const requires = 'requires' in p ? p.requires : null;
    await tx.update(permissions).set({ requires }).where(eq(permissions.key, p.key));
  }
  const removed = await tx
    .delete(permissions)
    .where(notInArray(permissions.key, catalogKeys))
    .returning({ key: permissions.key });
  if (removed.length > 0) {
    const keys = removed.map((r) => r.key);
    logger.db.warn({ keys }, 'Permissions removed from the catalog');
    await tx.insert(auditLogs).values({ action: 'catalog.permissions_removed', changes: { keys } });
  }

  // Built-in roles and exactly their catalog permissions.
  for (const role of BUILT_IN_ROLES) {
    const values = { key: role.key, name: role.name, description: role.description, scope: role.scope, is_system: true };
    const [saved] = await tx
      .insert(roles)
      .values(values)
      .onConflictDoUpdate({ target: roles.key, targetWhere: sql`key is not null`, set: values })
      .returning({ id: roles.id });
    const roleId = saved!.id;

    await tx
      .delete(rolePermissions)
      .where(and(eq(rolePermissions.role_id, roleId), notInArray(rolePermissions.permission_key, [...role.permissions])));
    await tx
      .insert(rolePermissions)
      .values(role.permissions.map((permission_key) => ({ role_id: roleId, permission_key })))
      .onConflictDoNothing();
  }

  const builtIns = await tx.select({ key: roles.key }).from(roles).where(inArray(roles.key, BUILT_IN_ROLES.map((r) => r.key)));
  logger.db.info({ permissions: catalogKeys.length, builtInRoles: builtIns.length }, 'Catalog synced');
}
