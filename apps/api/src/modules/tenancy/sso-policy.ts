/**
 * What the organization decides about single sign-on, as the iam module asks
 * it (configureSso, registered in index.ts). Runs inside auth's own
 * transactions, as iam_service.
 */

import { and, eq, isNull } from 'drizzle-orm';

import type { Tx } from '#/db/db';
import { profiles, roles } from '#/db/schema';

/** Owners: they keep their password where SSO is required, so a broken provider cannot lock the organization out. */
export async function isOrgOwner(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ key: roles.key })
    .from(profiles)
    .innerJoin(roles, eq(roles.id, profiles.org_role_id))
    .where(and(eq(profiles.id, userId), isNull(profiles.deleted_at)));
  return row?.key === 'owner';
}
