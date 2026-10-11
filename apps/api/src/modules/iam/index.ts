// The iam module's public surface. Other modules import from here only.
export { requireAuth } from './auth.middleware';
export { AUTH, RATE_LIMITS } from './iam.config';
export { authRoutes } from './iam.routes';
export { assertUsableDeviceKey, sendPasswordResetLink, setAccountActive } from './iam.service';
export type { AuthContext } from './iam.service';
export { hashPassword } from './passwords';
export { rateLimit } from './rate-limit';
export { createSession } from './sessions';
export type { SignInDevice, TokenPair } from './sessions';
export { consumeSetupToken, issueSetupToken } from './setup-tokens';
export { devicePublicKeySchema } from './tokens';
export { browserIdSchema, emailSchema, newPasswordSchema } from './iam.validators';
export { accountsFor, createUser, findUserByEmail, getUser } from './users';
export type { AccountSummary, User } from './users';
export { cleanUpIam, rotateSigningKeyIfDue } from './maintenance';
export type { IamCleanup } from './maintenance';
export { hasTwoFactor, isPending, requireTwoFactorWhen, resetTwoFactor, startSignIn, twoFactorUsersAmong } from './two-factor';
export type { SignInResult, TwoFactorPending } from './two-factor';
export {
  configureSso,
  createSsoConnection,
  deleteSsoConnection,
  finishSsoTest,
  listSsoConnections,
  passwordRefusedFor,
  setSsoRequired,
  ssoForEmail,
  ssoRequiredError,
  ssoRequiredForEmail,
  startSsoTest,
  updateSsoConnection,
} from './sso';
export type { SsoConnectionView, SsoHooks, SsoSettings, SsoTestResult } from './sso';
export { ssoConnectionSchema, ssoRequiredSchema, ssoTestFinishSchema } from './iam.validators';
