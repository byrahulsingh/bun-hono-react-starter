/**
 * Security settings: who must use two-factor sign-in. The rule applies at
 * each person's next sign-in; people already signed in stay signed in.
 */

import { eq, isNull } from 'drizzle-orm';

import { withApp, withIam } from '#/db/db';
import { organization, profiles } from '#/db/schema';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import type { AuthContext } from '#/modules/iam';
import { accountsFor, hasTwoFactor, twoFactorUsersAmong } from '#/modules/iam';
import type { TwoFactorPolicy } from '#/modules/tenancy/tenancy.catalog';

export interface SecuritySettings {
  two_factor_policy: TwoFactorPolicy;
  /** The caller has it on: required before any rule can be switched on. */
  you_have_two_factor: boolean;
  /** Active people who would be asked to set it up, per rule. */
  without_two_factor: { org_roles: number; everyone: number };
}

export async function securitySettings(auth: AuthContext): Promise<SecuritySettings> {
  return withIam(async (tx) => {
    const [org] = await tx.select({ policy: organization.two_factor_policy }).from(organization);
    const people = await tx
      .select({ id: profiles.id, orgRoleId: profiles.org_role_id })
      .from(profiles)
      .where(isNull(profiles.deleted_at));
    const ids = people.map((p) => p.id);
    const accounts = await accountsFor(tx, ids);
    const withTwoFactor = await twoFactorUsersAmong(tx, ids);
    const missing = people.filter((p) => accounts.get(p.id)?.active && !withTwoFactor.has(p.id));
    return {
      two_factor_policy: (org?.policy ?? 'off') as TwoFactorPolicy,
      you_have_two_factor: await hasTwoFactor(tx, auth.userId),
      without_two_factor: { org_roles: missing.filter((p) => p.orgRoleId).length, everyone: missing.length },
    };
  });
}

export async function setTwoFactorPolicy(auth: AuthContext, policy: TwoFactorPolicy, meta: RequestMeta) {
  // Requiring it without having it would lock the person setting it out of their own next sign-in.
  if (policy !== 'off' && !(await withIam((tx) => hasTwoFactor(tx, auth.userId)))) {
    throw new AppError(
      'CONFLICT',
      'Turn on two-factor sign-in for your own account first (Account page), so the rule cannot lock you out.',
    );
  }
  await withApp(async (tx) => {
    const [org] = await tx.select().from(organization).for('update');
    if (!org) throw new AppError('NOT_FOUND', 'Setup has not been completed.');
    if (org.two_factor_policy === policy) return;
    await tx.update(organization).set({ two_factor_policy: policy }).where(eq(organization.id, org.id));
    await recordAudit(
      tx,
      {
        action: 'organization.two_factor_policy_changed',
        actorUserId: auth.userId,
        targetType: 'organization',
        targetId: org.id,
        changes: { from: org.two_factor_policy, to: policy },
      },
      meta,
    );
  });
}
