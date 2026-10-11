import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { withIam } from '#/db/db';
import { apiResponse } from '#/libs/api-response';
import { AppError } from '#/libs/errors';
import { requestMeta } from '#/libs/request-meta';
import { validate } from '#/middleware/validate.middleware';
import { getBranding, MAX_ASSET_BYTES, removeBrandAsset, setBrandAsset, updateBranding } from '#/modules/branding';
import { requireAuth } from '#/modules/iam';
import { isOrgOwner, requirePermission } from '#/modules/tenancy';
import type { AppEnv } from '#/types/app.types';

import { emailServerSchema, removeEmailServer, saveEmailServer, testEmailServer } from './email-server.service';
import { emailSettings, emailStatus, sendTestEmail } from './email.service';
import { dismissOnboarding, getGeneralSettings, onboardingStatus, renameOrganization } from './organization.service';
import { securitySettings, setTwoFactorPolicy } from './security.service';
import { ownersOnly } from './owners-only';
import { ssoSettingsRoutes } from './sso.routes';
import { assetSlotSchema, brandingSchema, generalSettingsSchema, securitySchema } from './settings.validators';

const TOO_LARGE = 'Use an image of 512 KB or less.';

/** Mounted at /api/settings: the organization's settings. All need org.settings.manage. */
const manageSettings = requirePermission('org.settings.manage');
export const settingsRoutes = new Hono<AppEnv>()
  .use(requireAuth, manageSettings)

  .get('/general', async (c) => c.json(apiResponse({ success: true, message: 'ok', data: await getGeneralSettings() })))
  .patch('/general', validate('json', generalSettingsSchema), async (c) => {
    await renameOrganization(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Organization renamed' }));
  })

  .get('/branding', async (c) => c.json(apiResponse({ success: true, message: 'ok', data: await getBranding() })))
  .patch('/branding', validate('json', brandingSchema), async (c) => {
    const data = await updateBranding(c.get('auth').userId, c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Branding saved', data }));
  })
  // multipart/form-data with one `file`.
  .put(
    '/branding/:slot',
    validate('param', assetSlotSchema),
    bodyLimit({
      // Room for the multipart wrapping around the file itself.
      maxSize: MAX_ASSET_BYTES + 16 * 1024,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', TOO_LARGE);
      },
    }),
    async (c) => {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) throw new AppError('VALIDATION', 'Some fields are invalid.', { file: 'Choose an image' });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const data = await setBrandAsset(c.get('auth').userId, c.req.valid('param').slot, bytes, requestMeta(c));
      return c.json(apiResponse({ success: true, message: 'Image saved', data }));
    },
  )
  .delete('/branding/:slot', validate('param', assetSlotSchema), async (c) => {
    const data = await removeBrandAsset(c.get('auth').userId, c.req.valid('param').slot, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Image removed', data }));
  })

  .get('/email', async (c) => {
    const data = await emailSettings();
    const you_are_owner = await withIam((tx) => isOrgOwner(tx, c.get('auth').userId));
    return c.json(apiResponse({ success: true, message: 'ok', data: { ...data, you_are_owner } }));
  })
  .get('/email/status', async (c) => c.json(apiResponse({ success: true, message: 'ok', data: await emailStatus() })))
  // The mail server itself: owners only (it sees every email, reset links included).
  .put('/email/server', ownersOnly, validate('json', emailServerSchema), async (c) => {
    await saveEmailServer(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Mail server saved' }));
  })
  .post('/email/server/test', ownersOnly, validate('json', emailServerSchema), async (c) => {
    await testEmailServer(c.req.valid('json'));
    return c.json(apiResponse({ success: true, message: 'Connected and signed in' }));
  })
  .delete('/email/server', ownersOnly, async (c) => {
    await removeEmailServer(c.get('auth'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Mail server removed' }));
  })
  .post('/email/test', async (c) => {
    const data = await sendTestEmail(c.get('auth'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: `Test email sent to ${data.sent_to}`, data }));
  })

  .get('/security', async (c) => c.json(apiResponse({ success: true, message: 'ok', data: await securitySettings(c.get('auth')) })))
  .patch('/security', validate('json', securitySchema), async (c) => {
    await setTwoFactorPolicy(c.get('auth'), c.req.valid('json').two_factor_policy, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Security settings saved' }));
  })

  .route('/sso', ssoSettingsRoutes)

  .get('/onboarding', async (c) => c.json(apiResponse({ success: true, message: 'ok', data: await onboardingStatus() })))
  .post('/onboarding/dismiss', async (c) => {
    await dismissOnboarding(c.get('auth'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Checklist hidden' }));
  });
