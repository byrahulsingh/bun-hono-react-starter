import type { Context } from 'hono';
import { Hono } from 'hono';

import { apiResponse } from '#/libs/api-response';
import { AppError } from '#/libs/errors';
import { requestMeta } from '#/libs/request-meta';
import { validate } from '#/middleware/validate.middleware';
import { requireAuth } from '#/modules/iam';
import { requirePermission } from '#/modules/tenancy';
import type { AppEnv } from '#/types/app.types';

import { createProject, deleteProject, listProjects, updateProject } from './projects.service';
import { createProjectSchema, projectIdParamSchema, updateProjectSchema } from './projects.validators';

/** Mounted at /t/:tenantId/projects (routes/index.ts); requirePermission checks inside that tenant. */
function tenantIdOf(c: Context<AppEnv>): string {
  const id = c.req.param('tenantId');
  if (!id) throw new AppError('NOT_FOUND', 'Tenant not found.');
  return id;
}

export const projectRoutes = new Hono<AppEnv>()
  .get('/', requireAuth, requirePermission('projects.view'), async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await listProjects(tenantIdOf(c)) }));
  })
  .post('/', requireAuth, requirePermission('projects.create'), validate('json', createProjectSchema), async (c) => {
    const data = await createProject(c.get('auth'), tenantIdOf(c), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Project created', data }), 201);
  })
  .patch(
    '/:id',
    requireAuth,
    requirePermission('projects.edit'),
    validate('param', projectIdParamSchema),
    validate('json', updateProjectSchema),
    async (c) => {
      await updateProject(c.get('auth'), tenantIdOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c));
      return c.json(apiResponse({ success: true, message: 'Project saved' }));
    },
  )
  .delete('/:id', requireAuth, requirePermission('projects.delete'), validate('param', projectIdParamSchema), async (c) => {
    await deleteProject(c.get('auth'), tenantIdOf(c), c.req.valid('param').id, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Project deleted' }));
  });
