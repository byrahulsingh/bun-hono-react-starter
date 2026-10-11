import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { boolean, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id, timestamps } from '../column.helper';
import { modules, roleScopes } from './lookups.sql';
import { profiles } from './profiles.sql';
import { tenants } from './tenants.sql';

export const roles = pgTable(
  'roles',
  {
    id: id(),
    /** Built-in roles only ('owner', 'manager', …): what code and the catalog sync refer to. */
    key: text(),
    name: text().notNull(),
    description: text(),
    scope: text()
      .notNull()
      .references(() => roleScopes.key),
    /** Built-in: locked. To change one, copy it. */
    is_system: boolean().notNull().default(false),
    /** Null = available in every tenant (all roles in v1). */
    tenant_id: uuid().references((): AnyPgColumn => tenants.id),
    created_by: uuid().references((): AnyPgColumn => profiles.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('roles_key').on(t.key).where(sql`key is not null`),
    uniqueIndex('roles_name_live').on(sql`lower(${t.name})`).where(sql`deleted_at is null and tenant_id is null`),
  ],
);

/** Our catalog of permissions. Written only by the catalog sync (db/catalog.ts). */
export const permissions = pgTable('permissions', {
  key: text().primaryKey(),
  module_key: text()
    .notNull()
    .references(() => modules.key),
  action: text().notNull(),
  scope: text()
    .notNull()
    .references(() => roleScopes.key),
  label: text().notNull(),
  description: text(),
  /** The permission this one needs too, e.g. projects.edit requires projects.view. */
  requires: text().references((): AnyPgColumn => permissions.key),
  sort_order: integer().notNull().default(0),
});

/** A ticked box in the role editor. Untick = delete the row (audit_logs keeps the history). */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    role_id: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission_key: text()
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
    created_at: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.role_id, t.permission_key] })],
);
