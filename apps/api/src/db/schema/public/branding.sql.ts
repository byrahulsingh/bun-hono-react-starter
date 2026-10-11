import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { bytea, check, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id, timestamps } from '../column.helper';
import { profiles } from './profiles.sql';
import { tenants } from './tenants.sql';

/**
 * Uploaded logos and icons. Small (a few hundred KB at most), so they live in
 * Postgres until object storage exists. Never changed: a new upload is a new
 * row with a new id, so its public URL can be cached forever.
 */
export const brandAssets = pgTable('brand_assets', {
  id: id(),
  /** Decided by reading the file, never taken from the upload's own header. */
  content_type: text().notNull(),
  bytes: bytea().notNull(),
  size: integer().notNull(),
  created_by: uuid().references((): AnyPgColumn => profiles.id),
  created_at: createdAt(),
});

/**
 * How the product looks: the organization's row (tenant_id null) applies
 * everywhere; a tenant's row (later) overrides it for that tenant's own pages.
 * Missing row or null column: the built-in default.
 */
export const branding = pgTable(
  'branding',
  {
    id: id(),
    tenant_id: uuid().references(() => tenants.id),
    /** Shown in the browser tab, the sidebar, sign-in pages and emails. */
    product_name: text(),
    /** `#rrggbb`; buttons, links and focus rings take it. */
    accent_color: text(),
    logo_id: uuid().references(() => brandAssets.id),
    /** Square: the browser tab and the collapsed sidebar. */
    icon_id: uuid().references(() => brandAssets.id),
    updated_by: uuid().references((): AnyPgColumn => profiles.id),
    created_at: timestamps.created_at,
    updated_at: timestamps.updated_at,
  },
  (t) => [
    uniqueIndex('branding_org').on(sql`(true)`).where(sql`tenant_id is null`),
    uniqueIndex('branding_tenant').on(t.tenant_id).where(sql`tenant_id is not null`),
    check('branding_accent_color', sql`${t.accent_color} ~ '^#[0-9a-f]{6}$'`),
  ],
);
