/**
 * Reading the audit log (org.audit.view). Rows are written by recordAudit
 * (modules/audit) and never change; this only filters, pages and names them.
 *
 * Paging is by id: ids are UUIDv7, so "older than this id" is "older than
 * this moment", with no offset to drift while new rows arrive.
 *
 * Lives here, not in modules/audit, because naming the rows needs tenants,
 * roles and the iam module, which themselves write through modules/audit.
 */

import { and, desc, eq, gte, inArray, like, lt, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';

import { withApp, withIam } from '#/db/db';
import { auditLogs, invitations, profiles, roles, tenants } from '#/db/schema';
import { accountsFor } from '#/modules/iam';

import type { auditQuerySchema } from './tenancy.validators';

/** Filter groups, by action prefix. The client shows them as categories. */
export const AUDIT_CATEGORIES = {
  security: ['auth.', 'sso.'],
  people: ['invitation.', 'membership.', 'org_role.', 'user.'],
  roles: ['role.', 'catalog.'],
  tenants: ['tenant.'],
  account: ['profile.', 'setup.'],
  settings: ['organization.', 'branding.', 'email.'],
} as const;

export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

export interface AuditEntry {
  id: string;
  created_at: Date;
  action: string;
  actor_user_id: string | null;
  tenant_id: string | null;
  target_type: string | null;
  target_id: string | null;
  changes: Record<string, unknown> | null;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
}

/** Names for the ids in a page of entries, so the client can write sentences. */
export interface AuditRefs {
  users: Record<string, { name: string; email: string | null }>;
  tenants: Record<string, string>;
  roles: Record<string, string>;
  invitations: Record<string, string>;
}

export interface AuditPage {
  entries: AuditEntry[];
  refs: AuditRefs;
  /** Pass as `before` for the next (older) page; null when this was the last. */
  next: string | null;
}

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

export async function listAudit(query: z.infer<typeof auditQuerySchema>): Promise<AuditPage> {
  const rows = await withApp((tx) =>
    tx
      .select({
        id: auditLogs.id,
        created_at: auditLogs.created_at,
        action: auditLogs.action,
        actor_user_id: auditLogs.actor_user_id,
        tenant_id: auditLogs.tenant_id,
        target_type: auditLogs.target_type,
        target_id: auditLogs.target_id,
        changes: auditLogs.changes,
        request_id: auditLogs.request_id,
        ip: sql<string | null>`host(${auditLogs.ip})`,
        user_agent: auditLogs.user_agent,
      })
      .from(auditLogs)
      .where(
        and(
          query.before ? lt(auditLogs.id, query.before) : undefined,
          query.category ? or(...AUDIT_CATEGORIES[query.category].map((p) => like(auditLogs.action, `${p}%`))) : undefined,
          query.tenant ? eq(auditLogs.tenant_id, query.tenant) : undefined,
          // A person's own actions, and things done to them.
          query.actor
            ? or(eq(auditLogs.actor_user_id, query.actor), and(eq(auditLogs.target_type, 'user'), eq(auditLogs.target_id, query.actor)))
            : undefined,
          query.from ? gte(auditLogs.created_at, new Date(query.from)) : undefined,
          query.to ? lte(auditLogs.created_at, new Date(query.to)) : undefined,
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(query.limit + 1),
  );
  const entries = rows.slice(0, query.limit);
  const next = rows.length > query.limit ? entries.at(-1)!.id : null;
  return { entries, refs: await refsFor(entries), next };
}

async function refsFor(entries: AuditEntry[]): Promise<AuditRefs> {
  const userIds = new Set<string>();
  const tenantIds = new Set<string>();
  const roleIds = new Set<string>();
  const invitationIds = new Set<string>();
  for (const e of entries) {
    if (e.actor_user_id) userIds.add(e.actor_user_id);
    if (e.tenant_id) tenantIds.add(e.tenant_id);
    if (e.target_id) {
      if (e.target_type === 'user') userIds.add(e.target_id);
      if (e.target_type === 'role') roleIds.add(e.target_id);
      if (e.target_type === 'invitation') invitationIds.add(e.target_id);
      if (e.target_type === 'tenant') tenantIds.add(e.target_id);
    }
    for (const field of ['from_role_id', 'to_role_id', 'role_id']) {
      const value = e.changes?.[field];
      if (isUuid(value)) roleIds.add(value);
    }
  }

  // Deleted roles, tenants and people keep their names here: the history
  // must stay readable after they are gone.
  const named = await withApp(async (tx) => ({
    people: userIds.size
      ? await tx.select({ id: profiles.id, name: profiles.name }).from(profiles).where(inArray(profiles.id, [...userIds]))
      : [],
    tenants: tenantIds.size
      ? await tx.select({ id: tenants.id, name: tenants.name }).from(tenants).where(inArray(tenants.id, [...tenantIds]))
      : [],
    roles: roleIds.size ? await tx.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, [...roleIds])) : [],
    invitations: invitationIds.size
      ? await tx
          .select({ id: invitations.id, email: invitations.email })
          .from(invitations)
          .where(inArray(invitations.id, [...invitationIds]))
      : [],
  }));
  const accounts = await withIam((tx) => accountsFor(tx, [...userIds]));

  return {
    users: Object.fromEntries(
      named.people.map((p) => [p.id, { name: p.name, email: accounts.get(p.id)?.email ?? null }]),
    ),
    tenants: Object.fromEntries(named.tenants.map((t) => [t.id, t.name])),
    roles: Object.fromEntries(named.roles.map((r) => [r.id, r.name])),
    invitations: Object.fromEntries(named.invitations.map((i) => [i.id, i.email])),
  };
}

/** Choices for the filter bar: every tenant (archived too) and every person. */
export async function auditFilterOptions() {
  const { tenantRows, people } = await withApp(async (tx) => ({
    tenantRows: await tx
      .select({ id: tenants.id, name: tenants.name, status: tenants.status })
      .from(tenants)
      .orderBy(sql`lower(${tenants.name})`),
    people: await tx.select({ id: profiles.id, name: profiles.name }).from(profiles).orderBy(sql`lower(${profiles.name})`),
  }));
  const accounts = await withIam((tx) => accountsFor(tx, people.map((p) => p.id)));
  return {
    tenants: tenantRows,
    people: people.map((p) => ({ ...p, email: accounts.get(p.id)?.email ?? null })),
  };
}
