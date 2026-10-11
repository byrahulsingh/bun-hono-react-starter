/**
 * The organization's rule for who must use two-factor sign-in, as the iam
 * module asks it (requireTwoFactorWhen, registered in index.ts). Runs inside
 * auth's own transactions, as iam_service.
 */

import { and, eq, isNull } from 'drizzle-orm';

import type { Tx } from '#/db/db';
import { organization, profiles } from '#/db/schema';

import type { TwoFactorPolicy } from './tenancy.catalog';

export async function twoFactorRequiredFor(tx: Tx, userId: string): Promise<boolean> {
  const [org] = await tx.select({ policy: organization.two_factor_policy }).from(organization);
  const policy = (org?.policy ?? 'off') as TwoFactorPolicy;
  if (policy === 'off') return false;
  if (policy === 'everyone') return true;
  // org_roles: owners, admins and custom organization roles.
  const [profile] = await tx
    .select({ orgRoleId: profiles.org_role_id })
    .from(profiles)
    .where(and(eq(profiles.id, userId), isNull(profiles.deleted_at)));
  return Boolean(profile?.orgRoleId);
}
