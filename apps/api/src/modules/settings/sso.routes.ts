import { Hono } from 'hono';
import { z } from 'zod';

import { withIam } from '#/db/db';
import { apiResponse } from '#/libs/api-response';
import { requestMeta } from '#/libs/request-meta';
import { validate } from '#/middleware/validate.middleware';
import {
  createSsoConnection,
  deleteSsoConnection,
  finishSsoTest,
  listSsoConnections,
  setSsoRequired,
  ssoConnectionSchema,
  ssoRequiredSchema,
  ssoTestFinishSchema,
  startSsoTest,
  updateSsoConnection,
} from '#/modules/iam';
import { isOrgOwner } from '#/modules/tenancy';
import type { AppEnv } from '#/types/app.types';

import { ownersOnly } from './owners-only';

const idParam = z.object({ id: z.uuid('Not found') });


/** Mounted at /api/settings/sso, behind requireAuth and org.settings.manage. */
export const ssoSettingsRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const settings = await listSsoConnections();
    const you_are_owner = await withIam((tx) => isOrgOwner(tx, c.get('auth').userId));
    return c.json(apiResponse({ success: true, message: 'ok', data: { ...settings, you_are_owner } }));
  })
  .post('/', ownersOnly, validate('json', ssoConnectionSchema), async (c) => {
    const data = await createSsoConnection(c.get('auth').userId, c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Connection added', data }), 201);
  })
  // A test sign-in comes back here: the browser that started it hands over the code.
  .post('/test/finish', ownersOnly, validate('json', ssoTestFinishSchema), async (c) => {
    const data = await finishSsoTest(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: data.ok ? 'Test sign-in worked' : 'Test sign-in failed', data }));
  })
  .put('/:id', ownersOnly, validate('param', idParam), validate('json', ssoConnectionSchema), async (c) => {
    const data = await updateSsoConnection(c.get('auth').userId, c.req.valid('param').id, c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Connection saved', data }));
  })
  .delete('/:id', ownersOnly, validate('param', idParam), async (c) => {
    await deleteSsoConnection(c.get('auth').userId, c.req.valid('param').id, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Connection removed' }));
  })
  .put('/:id/required', ownersOnly, validate('param', idParam), validate('json', ssoRequiredSchema), async (c) => {
    const data = await setSsoRequired(c.get('auth').userId, c.req.valid('param').id, c.req.valid('json').required, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Saved', data }));
  })
  .post('/:id/test', ownersOnly, validate('param', idParam), async (c) => {
    const data = await startSsoTest(c.get('auth').userId, c.req.valid('param').id);
    return c.json(apiResponse({ success: true, message: 'ok', data }));
  });
