import { Hono } from 'hono';

import { apiResponse } from '#/libs/api-response';
import { requestMeta } from '#/libs/request-meta';
import { validate } from '#/middleware/validate.middleware';
import type { AppEnv } from '#/types/app.types';

import { requireAuth } from './auth.middleware';
import {
  changePassword,
  endMySession,
  forgotPassword,
  listMySessions,
  login,
  logout,
  refresh,
  resetPassword,
} from './iam.service';
import { cancelEmailChange, confirmEmailChange, pendingEmailChange, requestEmailChange } from './email-change';
import { previewSignInAlert, reportSignInAlert } from './known-devices';
import { finishSsoSignIn, signInMethods, ssoAvailable, startSsoSignIn } from './sso';
import {
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  disableTwoFactor,
  finishSetupAtSignIn,
  regenerateRecoveryCodes,
  startSetupAtSignIn,
  twoFactorStatus,
  verifySignIn,
} from './two-factor';
import {
  changePasswordSchema,
  codeOnlySchema,
  disableTwoFactorSchema,
  emailChangeSchema,
  linkTokenSchema,
  passwordOnlySchema,
  ssoFinishSchema,
  ssoStartSchema,
  signInCodeSchema,
  signInSetupSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  resetPasswordSchema,
  sessionIdParamSchema,
} from './iam.validators';

/** Mounted at /api/auth. */
export const authRoutes = new Hono<AppEnv>()
  .post('/login', validate('json', loginSchema), async (c) => {
    const data = await login(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Signed in', data }));
  })
  // Single sign-on: start (where to send the browser), then finish (the provider's code, from the same device).
  .get('/sso', async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: { available: await ssoAvailable() } }));
  })
  .post('/sso/start', validate('json', ssoStartSchema), async (c) => {
    const data = await startSsoSignIn(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'ok', data }));
  })
  .post('/sso/finish', validate('json', ssoFinishSchema), async (c) => {
    const data = await finishSsoSignIn(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Signed in', data }));
  })
  .get('/sign-in-methods', requireAuth, async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await signInMethods(c.get('auth')) }));
  })
  // The second step, when the first answered with `two_factor` instead of tokens.
  .post('/login/two-factor', validate('json', signInCodeSchema), async (c) => {
    const data = await verifySignIn(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Signed in', data }));
  })
  .post('/login/two-factor/setup', validate('json', signInSetupSchema), async (c) => {
    const data = await startSetupAtSignIn(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'ok', data }));
  })
  .post('/login/two-factor/setup/confirm', validate('json', signInCodeSchema), async (c) => {
    const data = await finishSetupAtSignIn(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Two-factor sign-in is on', data }));
  })
  // Your own two-factor, from the Account page.
  .get('/two-factor', requireAuth, async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await twoFactorStatus(c.get('auth')) }));
  })
  .post('/two-factor/setup', requireAuth, validate('json', passwordOnlySchema), async (c) => {
    const data = await beginTwoFactorSetup(c.get('auth'), c.req.valid('json'));
    return c.json(apiResponse({ success: true, message: 'ok', data }));
  })
  .post('/two-factor/confirm', requireAuth, validate('json', codeOnlySchema), async (c) => {
    const data = await confirmTwoFactorSetup(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Two-factor sign-in is on', data }));
  })
  .post('/two-factor/disable', requireAuth, validate('json', disableTwoFactorSchema), async (c) => {
    await disableTwoFactor(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Two-factor sign-in is off' }));
  })
  .post('/two-factor/recovery-codes', requireAuth, validate('json', codeOnlySchema), async (c) => {
    const data = await regenerateRecoveryCodes(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'New recovery codes made', data }));
  })
  .post('/refresh', validate('json', refreshSchema), async (c) => {
    const data = await refresh(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Refreshed', data }));
  })
  .post('/logout', requireAuth, validate('json', logoutSchema), async (c) => {
    await logout(c.get('auth'), c.req.valid('json').scope, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Signed out' }));
  })
  // The signed-in person's own devices.
  .get('/sessions', requireAuth, async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await listMySessions(c.get('auth')) }));
  })
  .delete('/sessions/:id', requireAuth, validate('param', sessionIdParamSchema), async (c) => {
    await endMySession(c.get('auth'), c.req.valid('param').id, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Signed out of that device' }));
  })
  .post('/change-password', requireAuth, validate('json', changePasswordSchema), async (c) => {
    await changePassword(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Password changed. Other devices were signed out.' }));
  })
  // Changing your sign-in email: asked for here, finished by the link sent to the new address.
  .get('/email-change', requireAuth, async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await pendingEmailChange(c.get('auth')) }));
  })
  .post('/email-change', requireAuth, validate('json', emailChangeSchema), async (c) => {
    const data = await requestEmailChange(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Confirmation link sent', data }));
  })
  .delete('/email-change', requireAuth, async (c) => {
    await cancelEmailChange(c.get('auth'));
    return c.json(apiResponse({ success: true, message: 'Email change cancelled' }));
  })
  .post('/email-change/confirm', validate('json', linkTokenSchema), async (c) => {
    const data = await confirmEmailChange(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Email changed', data }));
  })
  // The "This wasn't me" link in a new-device email.
  .post('/sign-in-alert/preview', validate('json', linkTokenSchema), async (c) => {
    const data = await previewSignInAlert(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'ok', data }));
  })
  .post('/sign-in-alert/report', validate('json', linkTokenSchema), async (c) => {
    await reportSignInAlert(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'That device was signed out' }));
  })
  .post('/forgot-password', validate('json', forgotPasswordSchema), async (c) => {
    await forgotPassword(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'If an account exists for that email, a reset link is on its way.' }));
  })
  .post('/reset-password', validate('json', resetPasswordSchema), async (c) => {
    const data = await resetPassword(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Password changed', data }));
  });
