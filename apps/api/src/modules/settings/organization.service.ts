/**
 * The organization's own settings (its name), and the getting-started
 * checklist an owner sees after setup. Both need org.settings.manage; the
 * routes check.
 */

import { and, count, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import type { Tx } from '#/db/db';
import { withApp } from '#/db/db';
import { branding, invitations, organization, profiles, tenants } from '#/db/schema';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import type { AuthContext } from '#/modules/iam';

async function lockOrganization(tx: Tx) {
  const [org] = await tx.select().from(organization).for('update');
  if (!org) throw new AppError('NOT_FOUND', 'Setup has not been completed.');
  return org;
}

export async function getGeneralSettings(): Promise<{ name: string; created_at: Date }> {
  return withApp(async (tx) => {
    const [org] = await tx.select({ name: organization.name, created_at: organization.created_at }).from(organization);
    if (!org) throw new AppError('NOT_FOUND', 'Setup has not been completed.');
    return org;
  });
}

/** Renames the organization only; the Main tenant keeps its own name. */
export async function renameOrganization(auth: AuthContext, input: { name: string }, meta: RequestMeta) {
  await withApp(async (tx) => {
    const org = await lockOrganization(tx);
    if (org.name === input.name) return;
    await tx.update(organization).set({ name: input.name }).where(eq(organization.id, org.id));
    await recordAudit(
      tx,
      { action: 'organization.renamed', actorUserId: auth.userId, targetType: 'organization', targetId: org.id, changes: { from: org.name, to: input.name } },
      meta,
    );
  });
}

// ─── Getting started ─────────────────────────────────────────────

export type OnboardingStepKey = 'branding' | 'email' | 'team' | 'tenant';

export interface Onboarding {
  dismissed: boolean;
  /** Every required step done: the checklist hides itself. */
  complete: boolean;
  steps: { key: OnboardingStepKey; done: boolean; optional: boolean }[];
}

/**
 * Each step is worked out from what really happened, never ticked by hand.
 * A product adds its own steps (say, "create your first project") the same way.
 */
export async function onboardingStatus(): Promise<Onboarding> {
  return withApp(async (tx) => {
    const [org] = await tx
      .select({ emailCheckedAt: organization.email_checked_at, dismissedAt: organization.onboarding_dismissed_at })
      .from(organization);
    if (!org) throw new AppError('NOT_FOUND', 'Setup has not been completed.');

    const [branded] = await tx
      .select({ id: branding.id })
      .from(branding)
      .where(and(isNull(branding.tenant_id), or(isNotNull(branding.product_name), isNotNull(branding.logo_id))));
    // Anyone besides the owner who set up, or an invitation on its way.
    const [people] = await tx.select({ n: count() }).from(profiles).where(isNull(profiles.deleted_at));
    const [invited] = await tx.select({ id: invitations.id }).from(invitations).where(ne(invitations.status, 'revoked')).limit(1);
    const [liveTenants] = await tx.select({ n: count() }).from(tenants).where(isNull(tenants.deleted_at));

    const steps: Onboarding['steps'] = [
      { key: 'branding', done: Boolean(branded), optional: false },
      { key: 'email', done: org.emailCheckedAt !== null, optional: false },
      { key: 'team', done: people!.n > 1 || Boolean(invited), optional: false },
      { key: 'tenant', done: liveTenants!.n > 1, optional: true },
    ];
    return {
      dismissed: org.dismissedAt !== null,
      complete: steps.every((s) => s.optional || s.done),
      steps,
    };
  });
}

/** Hides the checklist for every settings manager, not just this device. */
export async function dismissOnboarding(auth: AuthContext, meta: RequestMeta) {
  await withApp(async (tx) => {
    const org = await lockOrganization(tx);
    if (org.onboarding_dismissed_at) return;
    await tx.update(organization).set({ onboarding_dismissed_at: sql`now()` }).where(eq(organization.id, org.id));
    await recordAudit(tx, { action: 'organization.onboarding_dismissed', actorUserId: auth.userId, targetType: 'organization', targetId: org.id }, meta);
  });
}
