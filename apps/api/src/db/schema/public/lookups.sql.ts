import { pgTable } from 'drizzle-orm/pg-core';

import { lookupColumns } from '../column.helper';

/** org · tenant */
export const roleScopes = pgTable('role_scopes', lookupColumns());
/** active · archived */
export const tenantStatuses = pgTable('tenant_statuses', lookupColumns());
/** pending · accepted · revoked (expired is pending + expires_at in the past) */
export const invitationStatuses = pgTable('invitation_statuses', lookupColumns());
/** Groups of permissions, the rows of the role editor grid. */
export const modules = pgTable('modules', lookupColumns());
