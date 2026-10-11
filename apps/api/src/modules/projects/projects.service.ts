/**
 * The example module: projects inside a tenant. It shows the pattern every
 * feature follows, so copy it for your first real one:
 *
 *   - every query is scoped by the tenant id from the URL, never from the body;
 *   - each change and its audit row commit in one transaction;
 *   - deleting sets deleted_at, so history keeps pointing at something;
 *   - a uniqueness rule is checked first for a friendly message, and the
 *     unique index catches the race between two people saving at once.
 *
 * Permissions are checked by the routes (requirePermission), which also make
 * an archived tenant read-only: only *.view permissions remain there.
 */

import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { isUniqueViolation, withApp } from '#/db/db';
import { profiles, projects } from '#/db/schema';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import type { AuthContext } from '#/modules/iam';

import type { ProjectStatus } from './projects.catalog';
import type { createProjectSchema, updateProjectSchema } from './projects.validators';

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  /** Null when that person's profile is gone. */
  created_by: { id: string; name: string } | null;
  created_at: Date;
  updated_at: Date;
}

const NAME_TAKEN = () =>
  new AppError('VALIDATION', 'Some fields are invalid.', { name: 'A project with this name already exists here.' });
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Project not found.');

const live = (tenantId: string) => and(eq(projects.tenant_id, tenantId), isNull(projects.deleted_at));

async function nameTaken(tx: Tx, tenantId: string, name: string, exceptId?: string): Promise<boolean> {
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(live(tenantId), sql`lower(${projects.name}) = lower(${name})`, exceptId ? ne(projects.id, exceptId) : undefined))
    .limit(1);
  return rows.length > 0;
}

/** Turns a race on the unique index into the same message as the check before it. */
async function catchNameRace<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err, 'projects_name_live')) throw NAME_TAKEN();
    throw err;
  }
}

export async function listProjects(tenantId: string): Promise<Project[]> {
  return withApp(async (tx) => {
    const rows = await tx
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        status: projects.status,
        created_at: projects.created_at,
        updated_at: projects.updated_at,
        creator_id: profiles.id,
        creator_name: profiles.name,
      })
      .from(projects)
      .leftJoin(profiles, eq(profiles.id, projects.created_by))
      .where(live(tenantId))
      .orderBy(asc(sql`lower(${projects.name})`));
    return rows.map(({ creator_id, creator_name, ...row }) => ({
      ...row,
      status: row.status as ProjectStatus,
      created_by: creator_id && creator_name ? { id: creator_id, name: creator_name } : null,
    }));
  });
}

export async function createProject(
  auth: AuthContext,
  tenantId: string,
  input: z.infer<typeof createProjectSchema>,
  meta: RequestMeta,
): Promise<{ id: string; name: string }> {
  return catchNameRace(() =>
    withApp(async (tx) => {
      if (await nameTaken(tx, tenantId, input.name)) throw NAME_TAKEN();
      const [project] = await tx
        .insert(projects)
        .values({ tenant_id: tenantId, name: input.name, description: input.description, created_by: auth.userId })
        .returning({ id: projects.id, name: projects.name });
      await recordAudit(
        tx,
        { action: 'project.created', actorUserId: auth.userId, tenantId, targetType: 'project', targetId: project!.id, changes: { project: input.name } },
        meta,
      );
      return project!;
    }),
  );
}

async function lockProject(tx: Tx, tenantId: string, id: string) {
  const [project] = await tx
    .select({ name: projects.name, description: projects.description, status: projects.status })
    .from(projects)
    .where(and(live(tenantId), eq(projects.id, id)))
    .for('update');
  // Another tenant's project is "not found" too: its existence is not revealed.
  if (!project) throw NOT_FOUND();
  return project;
}

export async function updateProject(
  auth: AuthContext,
  tenantId: string,
  id: string,
  input: z.infer<typeof updateProjectSchema>,
  meta: RequestMeta,
): Promise<void> {
  await catchNameRace(() =>
    withApp(async (tx) => {
      const before = await lockProject(tx, tenantId, id);
      // Only what actually changed is saved and audited, as { from, to }.
      const changed: Record<string, { from: string; to: string }> = {};
      for (const key of ['name', 'description', 'status'] as const) {
        const next = input[key];
        if (next !== undefined && next !== before[key]) changed[key] = { from: before[key], to: next };
      }
      if (Object.keys(changed).length === 0) return;
      if (changed.name && (await nameTaken(tx, tenantId, changed.name.to, id))) throw NAME_TAKEN();

      await tx
        .update(projects)
        .set(Object.fromEntries(Object.entries(changed).map(([key, value]) => [key, value.to])))
        .where(eq(projects.id, id));
      await recordAudit(
        tx,
        {
          action: 'project.updated',
          actorUserId: auth.userId,
          tenantId,
          targetType: 'project',
          targetId: id,
          changes: { project: changed.name?.to ?? before.name, ...changed },
        },
        meta,
      );
    }),
  );
}

export async function deleteProject(auth: AuthContext, tenantId: string, id: string, meta: RequestMeta): Promise<void> {
  await withApp(async (tx) => {
    const project = await lockProject(tx, tenantId, id);
    await tx.update(projects).set({ deleted_at: new Date() }).where(eq(projects.id, id));
    await recordAudit(
      tx,
      { action: 'project.deleted', actorUserId: auth.userId, tenantId, targetType: 'project', targetId: id, changes: { project: project.name } },
      meta,
    );
  });
}
