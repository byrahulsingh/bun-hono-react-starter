/**
 * The example module's data (modules/projects): a table that belongs to a
 * tenant, with a status from a lookup table. Copy it for your first real
 * table, or remove the module (see "The example module" in the README).
 */

import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { id, lookupColumns, timestamps } from '../column.helper';
import { profiles } from './profiles.sql';
import { tenants } from './tenants.sql';

/** active · on_hold · done */
export const projectStatuses = pgTable('project_statuses', lookupColumns());

export const projects = pgTable(
  'projects',
  {
    id: id(),
    /** Every row of tenant data says whose it is; queries always filter by it. */
    tenant_id: uuid()
      .notNull()
      .references(() => tenants.id),
    name: text().notNull(),
    description: text().notNull().default(''),
    status: text()
      .notNull()
      .default('active')
      .references(() => projectStatuses.key),
    created_by: uuid().references(() => profiles.id),
    ...timestamps,
  },
  (t) => [
    // Names are unique within a tenant (two tenants may both have "Website").
    uniqueIndex('projects_name_live').on(t.tenant_id, sql`lower(${t.name})`).where(sql`deleted_at is null`),
    index('projects_tenant_id').on(t.tenant_id),
  ],
);
