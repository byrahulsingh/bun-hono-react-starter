import { index, inet, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id } from '../column.helper';

/**
 * Append-only history of security-relevant events and changes. The database
 * roles may insert and read, never update or delete (see the grants migration).
 *
 * No foreign keys on purpose: an insert needs no lookups, and the history
 * survives when a user or tenant is purged. Only two indexes, because every
 * index slows every insert.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    /** UUIDv7, so ids sort by time. */
    id: id(),
    created_at: createdAt(),
    /** Null = the system itself (migrations, jobs). */
    actor_user_id: uuid(),
    /** Null = an org-level event. */
    tenant_id: uuid(),
    /** `domain.verb`, e.g. `auth.login`, `role.permissions_changed`. */
    action: text().notNull(),
    target_type: text(),
    target_id: uuid(),
    /** What changed: `{ before, after }`, or event details. Never secrets. */
    changes: jsonb().$type<Record<string, unknown>>(),
    request_id: text(),
    ip: inet(),
    user_agent: text(),
  },
  (t) => [
    index('audit_logs_tenant_time').on(t.tenant_id, t.created_at),
    index('audit_logs_actor_time').on(t.actor_user_id, t.created_at),
  ],
);
