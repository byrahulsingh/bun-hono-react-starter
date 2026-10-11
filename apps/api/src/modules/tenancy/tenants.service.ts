/**
 * Tenants: the workspaces inside the organization (one per client of an
 * agency, or one per team). Creating one needs org.tenants.manage; whoever has
 * an org role sees every tenant, everyone else only those they are a member of.
 */

import { and, asc, count, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { isUniqueViolation, withApp } from '#/db/db';
import { tenantMemberships, tenants } from '#/db/schema';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import type { AuthContext } from '#/modules/iam';

import type { createTenantSchema, renameTenantSchema } from './tenancy.validators';

const NAME_TAKEN = () =>
  new AppError('VALIDATION', 'Some fields are invalid.', { name: 'A tenant with this name already exists.' });

async function nameTaken(tx: Tx, name: string, exceptId?: string): Promise<boolean> {
  const rows = await tx
    .select({ id: tenants.id })
    .from(tenants)
    .where(
      and(
        sql`lower(${tenants.name}) = lower(${name})`,
        isNull(tenants.deleted_at),
        exceptId ? ne(tenants.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function createTenant(
  auth: AuthContext,
  input: z.infer<typeof createTenantSchema>,
  meta: RequestMeta,
): Promise<{ id: string; name: string }> {
  try {
    return await withApp(async (tx) => {
      if (await nameTaken(tx, input.name)) throw NAME_TAKEN();
      const [tenant] = await tx
        .insert(tenants)
        .values({ name: input.name, created_by: auth.userId })
        .returning({ id: tenants.id, name: tenants.name });
      await recordAudit(
        tx,
        { action: 'tenant.created', actorUserId: auth.userId, tenantId: tenant!.id, targetType: 'tenant', targetId: tenant!.id, changes: { name: input.name } },
        meta,
      );
      return tenant!;
    });
  } catch (err) {
    // Two people creating the same name at the same moment: one wins.
    if (isUniqueViolation(err, 'tenants_name_live')) throw NAME_TAKEN();
    throw err;
  }
}

// ─── Managing tenants (org.tenants.manage) ───────────────────────

export interface TenantSummary {
  id: string;
  name: string;
  status: 'active' | 'archived';
  /** The organization's own tenant (made at setup): listed first, never archived. */
  is_main: boolean;
  /** Tenant members only; owners and admins see every tenant on top of these. */
  member_count: number;
  created_at: Date;
}

/** Every tenant, archived ones included, by name. */
export async function listTenants(): Promise<TenantSummary[]> {
  return withApp(async (tx) => {
    const rows = await tx
      .select({
        id: tenants.id,
        name: tenants.name,
        status: tenants.status,
        is_main: tenants.is_main,
        created_at: tenants.created_at,
        member_count: count(tenantMemberships.id),
      })
      .from(tenants)
      .leftJoin(tenantMemberships, and(eq(tenantMemberships.tenant_id, tenants.id), isNull(tenantMemberships.deleted_at)))
      .where(isNull(tenants.deleted_at))
      .groupBy(tenants.id)
      .orderBy(desc(tenants.is_main), asc(sql`lower(${tenants.name})`));
    return rows.map((r) => ({ ...r, status: r.status as TenantSummary['status'] }));
  });
}

async function lockTenant(tx: Tx, id: string) {
  const [tenant] = await tx
    .select({ id: tenants.id, name: tenants.name, status: tenants.status, isMain: tenants.is_main })
    .from(tenants)
    .where(and(eq(tenants.id, id), isNull(tenants.deleted_at)))
    .for('update');
  if (!tenant) throw new AppError('NOT_FOUND', 'Tenant not found.');
  return tenant;
}

export async function renameTenant(auth: AuthContext, id: string, input: z.infer<typeof renameTenantSchema>, meta: RequestMeta) {
  try {
    await withApp(async (tx) => {
      const tenant = await lockTenant(tx, id);
      if (tenant.name === input.name) return;
      if (await nameTaken(tx, input.name, id)) throw NAME_TAKEN();
      await tx.update(tenants).set({ name: input.name }).where(eq(tenants.id, id));
      await recordAudit(
        tx,
        { action: 'tenant.renamed', actorUserId: auth.userId, tenantId: id, targetType: 'tenant', targetId: id, changes: { from: tenant.name, to: input.name } },
        meta,
      );
    });
  } catch (err) {
    if (isUniqueViolation(err, 'tenants_name_live')) throw NAME_TAKEN();
    throw err;
  }
}

/**
 * Archived: hidden from the switcher and read-only (only *.view permissions
 * remain), until restored. Nothing is deleted.
 */
export async function setTenantArchived(auth: AuthContext, id: string, archived: boolean, meta: RequestMeta) {
  await withApp(async (tx) => {
    const tenant = await lockTenant(tx, id);
    const next = archived ? 'archived' : 'active';
    if (tenant.status === next) return;
    if (archived && tenant.isMain) {
      throw new AppError('CONFLICT', "The main tenant is the organization's own and cannot be archived.");
    }
    if (archived) {
      // Locks every active tenant, so two people archiving the last two at
      // once cannot both succeed.
      const active = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(and(eq(tenants.status, 'active'), isNull(tenants.deleted_at)))
        .for('update');
      if (active.length <= 1) {
        throw new AppError('CONFLICT', 'This is the only active tenant. Create another one before archiving it.');
      }
    }
    await tx.update(tenants).set({ status: next }).where(eq(tenants.id, id));
    await recordAudit(
      tx,
      { action: archived ? 'tenant.archived' : 'tenant.restored', actorUserId: auth.userId, tenantId: id, targetType: 'tenant', targetId: id },
      meta,
    );
  });
}
