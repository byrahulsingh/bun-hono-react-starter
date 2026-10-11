import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { boolean, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { id, timestamps } from '../column.helper';
import { tenantStatuses } from './lookups.sql';
import { profiles } from './profiles.sql';
import { roles } from './roles.sql';

export const tenants = pgTable(
  'tenants',
  {
    id: id(),
    name: text().notNull(),
    status: text()
      .notNull()
      .default('active')
      .references(() => tenantStatuses.key),
    is_active: boolean().generatedAlwaysAs(sql`status = 'active' and deleted_at is null`),
    /** The organization's own tenant, made at setup (the rest are clients or teams). Never archived. */
    is_main: boolean().notNull().default(false),
    created_by: uuid().references((): AnyPgColumn => profiles.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tenants_name_live').on(sql`lower(${t.name})`).where(sql`deleted_at is null`),
    // At most one main tenant.
    uniqueIndex('tenants_one_main').on(sql`(true)`).where(sql`is_main and deleted_at is null`),
  ],
);

/** Who works in which tenant, as what. Removed from a tenant = deleted_at set. */
export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    id: id(),
    tenant_id: uuid()
      .notNull()
      .references(() => tenants.id),
    user_id: uuid()
      .notNull()
      .references((): AnyPgColumn => profiles.id),
    role_id: uuid()
      .notNull()
      .references((): AnyPgColumn => roles.id),
    created_by: uuid().references((): AnyPgColumn => profiles.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tenant_memberships_live').on(t.tenant_id, t.user_id).where(sql`deleted_at is null`),
    index('tenant_memberships_user_id').on(t.user_id),
  ],
);
