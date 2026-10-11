/**
 * Database roles and grants, derived from the Drizzle schema.
 *
 * drizzle-kit generates tables, indexes and checks, but cannot declare GRANTs,
 * so they are applied here instead of in hand-written migrations. Runs in the
 * migrate job after the migrations, every time; every statement is idempotent,
 * and each table's grants are reset and re-applied, so the database always
 * matches this file exactly.
 *
 * The rule, with two lists of exceptions below:
 *   tables in schema `iam`     → iam_service: everything; app_user: nothing
 *   tables in schema `public`  → app_user: everything; iam_service: only IAM_SERVICE_PUBLIC
 */

import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';

import type { Tx } from '#/db/db';
import type { DbRole } from '#/db/roles';
import * as schema from '#/db/schema';
import {
  auditLogs,
  invitations,
  organization,
  outbox,
  permissions,
  profiles,
  rolePermissions,
  roles,
  tenantMemberships,
  tenants,
} from '#/db/schema';

type Privilege = 'select' | 'insert' | 'update' | 'delete';

const ALL: Privilege[] = ['select', 'insert', 'update', 'delete'];

const ROLES: DbRole[] = ['app_user', 'iam_service'];

/** app_user gets everything in `public` except these. */
const APP_USER_PUBLIC_EXCEPTIONS = new Map<PgTable, Privilege[]>([
  // Append-only: history can be added and read, never edited or erased.
  [auditLogs, ['select', 'insert']],
]);

/**
 * The only `public` tables auth may touch: setup creates the organization, the
 * default tenant and the owner's profile; accepting an invitation creates a
 * profile and a membership; /me reads roles and tenants.
 */
const IAM_SERVICE_PUBLIC = new Map<PgTable, Privilege[]>([
  [organization, ['select', 'insert']],
  [tenants, ['select', 'insert']],
  [profiles, ['select', 'insert', 'update']],
  [roles, ['select']],
  [rolePermissions, ['select']],
  [permissions, ['select']],
  [tenantMemberships, ['select', 'insert']],
  [invitations, ['select', 'update']],
  [auditLogs, ['insert']],
  [outbox, ['insert']],
]);

function privilegesFor(role: DbRole, table: PgTable, tableSchema: string): Privilege[] {
  if (tableSchema === 'iam') return role === 'iam_service' ? ALL : [];
  if (role === 'app_user') return APP_USER_PUBLIC_EXCEPTIONS.get(table) ?? ALL;
  return IAM_SERVICE_PUBLIC.get(table) ?? [];
}

export async function syncDatabaseAccess(tx: Tx) {
  // Roles belong to the whole server, so another database may have made them
  // already. NOLOGIN: nobody connects as them; the app's login role switches
  // into them per transaction.
  for (const role of ROLES) {
    await tx.execute(
      sql.raw(
        `do $$ begin if not exists (select from pg_roles where rolname = '${role}') then create role ${role} nologin; end if; end $$`,
      ),
    );
  }
  // The login role must be a member to `set role` into them. (A superuser can
  // anyway; this matters for a least-privilege login on managed Postgres.)
  await tx.execute(sql.raw(`grant ${ROLES.join(', ')} to current_user`));

  await tx.execute(sql.raw(`grant usage on schema public to ${ROLES.join(', ')}`));
  await tx.execute(sql.raw(`grant usage on schema iam to iam_service`));
  await tx.execute(sql.raw(`revoke all on schema iam from public, app_user`));

  const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable));
  for (const table of tables) {
    const config = getTableConfig(table);
    const tableSchema = config.schema ?? 'public';
    const name = `"${tableSchema}"."${config.name}"`;

    await tx.execute(sql.raw(`revoke all on table ${name} from ${ROLES.join(', ')}`));
    for (const role of ROLES) {
      const privileges = privilegesFor(role, table, tableSchema);
      if (privileges.length > 0) {
        await tx.execute(sql.raw(`grant ${privileges.join(', ')} on table ${name} to ${role}`));
      }
    }
  }
}
