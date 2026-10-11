import { sql } from 'drizzle-orm';
import { boolean, bytea, check, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { id, timestamps, tstz } from '../column.helper';
import { invitationStatuses } from './lookups.sql';
import { profiles } from './profiles.sql';
import { roles } from './roles.sql';
import { tenants } from './tenants.sql';

/** One table for org invites (tenant_id null) and tenant invites. */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    email: text().notNull(),
    tenant_id: uuid().references(() => tenants.id),
    /** Must match the invite's level: an org role without a tenant, a tenant role with one. */
    role_id: uuid()
      .notNull()
      .references(() => roles.id),
    /** Keyed hash; the raw token only ever exists in the emailed link. */
    token_hash: bytea().notNull(),
    status: text()
      .notNull()
      .default('pending')
      .references(() => invitationStatuses.key),
    is_active: boolean().generatedAlwaysAs(sql`status = 'pending' and deleted_at is null`),
    expires_at: tstz().notNull(),
    accepted_at: tstz(),
    invited_by: uuid().references(() => profiles.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('invitations_token_hash').on(t.token_hash),
    // One open invite per email per place. coalesce() so org invites (no
    // tenant) collide with each other too: NULLs are never equal in an index.
    uniqueIndex('invitations_one_open')
      .on(t.email, sql`coalesce(${t.tenant_id}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`status = 'pending' and deleted_at is null`),
    check('invitations_email_lowercase', sql`email = lower(email)`),
  ],
);
