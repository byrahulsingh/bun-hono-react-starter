/**
 * The organization, its first owner, and what a signed-in person can see.
 *
 * Setup and /me read and write login data (schema iam), so they run as
 * iam_service, through the iam module's exported functions.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { withApp, withIam } from '#/db/db';
import {
  organization,
  permissions,
  profiles,
  rolePermissions,
  roles,
  tenantMemberships,
  tenants,
} from '#/db/schema';
import { env } from '#/libs/env';
import { AppError } from '#/libs/errors';
import { logger } from '#/libs/logger';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import type { AuthContext, TokenPair } from '#/modules/iam';
import {
  assertUsableDeviceKey,
  consumeSetupToken,
  createSession,
  createUser,
  getUser,
  hashPassword,
  issueSetupToken,
  rateLimit,
  RATE_LIMITS,
} from '#/modules/iam';

import type { setupSchema, updateProfileSchema } from './tenancy.validators';

/** Any fixed number: serializes concurrent setup attempts. */
const SETUP_LOCK_ID = 872_402;

async function organizationExists(tx: Tx): Promise<boolean> {
  const rows = await tx.select({ id: organization.id }).from(organization).limit(1);
  return rows.length > 0;
}

async function builtInRoleId(tx: Tx, key: string): Promise<string> {
  const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, key));
  if (!role) throw new Error(`Built-in role "${key}" is missing — has the migrate step run?`);
  return role.id;
}

// ─── Setup ───────────────────────────────────────────────────────

export async function setupStatus(): Promise<{ needs_setup: boolean }> {
  return { needs_setup: !(await withIam(organizationExists)) };
}

/**
 * At startup: if the install has no organization yet, make sure someone can
 * reach the setup page — print a one-time link, or point to SETUP_TOKEN.
 */
export async function announceSetupIfNeeded(): Promise<void> {
  if (!(await setupStatus()).needs_setup) return;
  if (env.SETUP_TOKEN) {
    logger.auth.warn(`Setup needed: open ${env.APP_URL}/setup and enter SETUP_TOKEN to create the owner account.`);
    return;
  }
  const token = await withIam(issueSetupToken);
  // Printed on purpose: this log line is how the installer reaches setup.
  // Each restart before setup prints a new link and voids the previous one.
  logger.auth.warn(`Setup needed. Open this link to create the owner account (single use, valid 24 h): ${env.APP_URL}/setup?token=${token}`);
}

export async function completeSetup(input: z.infer<typeof setupSchema>, meta: RequestMeta): Promise<TokenPair> {
  await assertUsableDeviceKey(input.device_public_key);
  await rateLimit(`link:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.linkPerIp);
  const passwordHash = await hashPassword(input.password);

  return withIam(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_ID})`);
    if (await organizationExists(tx)) throw new AppError('GONE', 'Setup is already complete. Sign in instead.');
    if (!(await consumeSetupToken(tx, input.token))) {
      throw new AppError('LINK_INVALID', 'This setup link is invalid or has expired. Restart the server to print a new one.');
    }

    const user = await createUser(tx, { email: input.email, passwordHash, emailConfirmed: true });
    const [org] = await tx.insert(organization).values({ name: input.organization_name }).returning({ id: organization.id });
    await tx.insert(profiles).values({ id: user.id, name: input.name, org_role_id: await builtInRoleId(tx, 'owner') });
    // Every install starts with one tenant, named after the organization.
    const [tenant] = await tx
      .insert(tenants)
      .values({ name: input.organization_name, created_by: user.id, is_main: true })
      .returning({ id: tenants.id });

    await recordAudit(
      tx,
      { action: 'setup.completed', actorUserId: user.id, targetType: 'organization', targetId: org!.id, changes: { default_tenant_id: tenant!.id } },
      meta,
    );
    return createSession(tx, { userId: user.id, devicePublicKey: input.device_public_key, browserId: input.browser_id, meta });
  });
}

// ─── Me ──────────────────────────────────────────────────────────

export interface Me {
  user: { id: string; email: string; name: string };
  /** owner / admin, or null when access comes only from tenant memberships. */
  org_role: { id: string; key: string | null; name: string } | null;
  /** Org-level permission keys (tenant permissions are asked per tenant). */
  org_permissions: string[];
  /** Tenants this person can open; role is null when access comes from the org role. */
  /** Main tenant first (the organization's own), then by name. */
  tenants: { id: string; name: string; is_main: boolean; role: { id: string; name: string } | null }[];
}

export async function getMe(auth: AuthContext): Promise<Me> {
  return withIam(async (tx) => {
    const user = await getUser(tx, auth.userId);
    const [profile] = await tx.select().from(profiles).where(eq(profiles.id, auth.userId));
    if (!user || !profile) throw new AppError('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');

    let orgRole: Me['org_role'] = null;
    let orgPermissions: string[] = [];
    if (profile.org_role_id) {
      const [role] = await tx
        .select({ id: roles.id, key: roles.key, name: roles.name })
        .from(roles)
        .where(and(eq(roles.id, profile.org_role_id), isNull(roles.deleted_at)));
      if (role) {
        orgRole = role;
        const rows = await tx
          .select({ key: permissions.key })
          .from(rolePermissions)
          .innerJoin(permissions, eq(permissions.key, rolePermissions.permission_key))
          .where(and(eq(rolePermissions.role_id, role.id), eq(permissions.scope, 'org')))
          .orderBy(asc(permissions.sort_order));
        orgPermissions = rows.map((r) => r.key);
      }
    }

    const tenantList = orgRole
      ? (
          await tx
            .select({ id: tenants.id, name: tenants.name, is_main: tenants.is_main })
            .from(tenants)
            .where(eq(tenants.is_active, true))
            .orderBy(desc(tenants.is_main), asc(tenants.name))
        ).map((t) => ({ ...t, role: null }))
      : (
          await tx
            .select({ id: tenants.id, name: tenants.name, is_main: tenants.is_main, roleId: roles.id, roleName: roles.name })
            .from(tenantMemberships)
            .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenant_id))
            .innerJoin(roles, eq(roles.id, tenantMemberships.role_id))
            .where(and(eq(tenantMemberships.user_id, auth.userId), isNull(tenantMemberships.deleted_at), eq(tenants.is_active, true)))
            .orderBy(desc(tenants.is_main), asc(tenants.name))
        ).map((t) => ({ id: t.id, name: t.name, is_main: t.is_main, role: { id: t.roleId, name: t.roleName } }));

    return {
      user: { id: user.id, email: user.email, name: profile.name },
      org_role: orgRole,
      org_permissions: orgPermissions,
      tenants: tenantList,
    };
  });
}

/** The person's own profile. Email lives with the login and changes elsewhere (not yet). */
export async function updateProfile(auth: AuthContext, input: z.infer<typeof updateProfileSchema>, meta: RequestMeta) {
  await withApp(async (tx) => {
    const [before] = await tx.select({ name: profiles.name }).from(profiles).where(eq(profiles.id, auth.userId));
    if (!before) throw new AppError('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
    if (before.name === input.name) return;
    await tx.update(profiles).set({ name: input.name }).where(eq(profiles.id, auth.userId));
    await recordAudit(
      tx,
      { action: 'profile.updated', actorUserId: auth.userId, targetType: 'user', targetId: auth.userId, changes: { name: { from: before.name, to: input.name } } },
      meta,
    );
  });
}
