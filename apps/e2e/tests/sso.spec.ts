/**
 * Single sign-on, end to end, against a real OpenID Connect provider (Dex,
 * from compose.yaml: `bun run db:up`). Every redirect is real: to Dex's own
 * sign-in page and back to /sso/callback.
 *
 * The Dex users have fixed addresses (dev/dex/config.yaml), so their old
 * emails are cleared first. Afterwards the connection is removed, so the
 * specs that follow see an install without SSO.
 */

import {
  DEX,
  OWNER,
  PASSWORD,
  addPerson,
  clearMail,
  dexSignIn,
  expect,
  linkIn,
  mailTo,
  newDevice,
  ownerApi,
  signIn,
  signInAsOwner,
  sql,
  test,
  tenantIdOf,
} from './support'

test.describe.configure({ mode: 'serial' })

const BEN = { email: 'ben@sso.test', name: 'Ben Password' } // has a password account first
const ADA = 'ada@sso.test' // only invited
const CY = 'cy@sso.test' // at Dex, but nobody invited them
const EVE = 'eve@other.test' // at Dex, outside the connection's domain

let settingsUrl = ''

test.beforeAll(async () => {
  await Promise.all([BEN.email, ADA, CY, EVE].map(clearMail))
})

test.afterAll(() => {
  sql(`delete from iam.sso_connections`)
})

test('an owner adds the connection, sees a wrong secret fail, then a test sign-in work', async ({ page }) => {
  await signInAsOwner(page)
  settingsUrl = `/t/${tenantIdOf(page)}/org/settings?tab=sso`
  await page.goto(settingsUrl)
  await expect(page.getByLabel('Redirect URL')).toHaveText('http://localhost:3100/sso/callback')

  await page.getByRole('button', { name: 'Add connection' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name on the sign-in button').fill('Dex SSO')
  await dialog.getByLabel('Issuer URL').fill('http://localhost:5556/nothing-here')
  await dialog.getByLabel('Client ID').fill(DEX.clientId)
  await dialog.getByLabel('Client secret').fill('not-the-secret')
  await dialog.getByLabel('Email domains').fill('sso.test')
  await dialog.getByRole('button', { name: 'Add connection' }).click()
  // Checked against the provider before saving.
  await expect(dialog.getByText(/discovery document .* answered HTTP 404/)).toBeVisible()
  await dialog.getByLabel('Issuer URL').fill(DEX.issuer)
  await dialog.getByRole('button', { name: 'Add connection' }).click()
  await expect(dialog).toHaveCount(0)

  const card = page.getByRole('listitem', { name: 'Dex SSO' })
  await expect(card).toContainText('Not tested yet')
  await expect(card.getByRole('button', { name: 'Require for these domains' })).toBeDisabled()

  // The wrong secret: the provider refuses the code at the token endpoint.
  await card.getByRole('button', { name: 'Test sign-in' }).click()
  await dexSignIn(page, BEN.email)
  await expect(page.getByRole('alert')).toContainText('Test sign-in with Dex SSO failed')
  await expect(page.getByRole('alert')).toContainText('refused the sign-in code')

  await card.getByRole('button', { name: 'Edit' }).click()
  await dialog.getByLabel('Client secret').fill(DEX.clientSecret)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)

  await card.getByRole('button', { name: 'Test sign-in' }).click()
  await dexSignIn(page, BEN.email)
  const result = page.getByRole('alert')
  await expect(result).toContainText('Test sign-in with Dex SSO worked')
  await expect(result).toContainText(`${BEN.email} (verified)`)
  await expect(card).toContainText('Tested')
  // Testing signs nobody in: the owner is still the owner.
  await expect(page.locator('[data-sidebar=menu-button]', { hasText: OWNER.email })).toHaveCount(1)
})

test('an existing account signs in with SSO the first time and is linked', async ({ browser }) => {
  await addPerson(await ownerApi(), { ...BEN, role: 'Admin', tenantId: null })
  const page = await newDevice(browser)
  await page.goto('/login')
  await page.getByRole('link', { name: 'Sign in with SSO' }).click()
  await page.getByLabel('Work email').fill(BEN.email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await dexSignIn(page, BEN.email)
  await expect(page).toHaveURL(/\/t\//)
  await expect(page.locator('[data-sidebar=menu-button]', { hasText: BEN.email })).toHaveCount(1)
  // The code never stays in the address bar or history.
  expect(page.url()).not.toContain('code=')
  await page.context().close()
})

test('an invited person joins through SSO: account made, no password, invitation accepted', async ({ browser }) => {
  const api = await ownerApi()
  await api.call('POST', '/invitations', { email: ADA, role_id: await api.roleId('org', 'Admin') })
  const page = await newDevice(browser)
  await page.goto(linkIn(await mailTo(ADA, 'invited you'), '/invite'))
  await page.getByRole('button', { name: 'Continue with Dex SSO' }).click()
  await dexSignIn(page, ADA)
  await expect(page).toHaveURL(/\/t\//)
  await expect(page.locator('[data-sidebar=menu-button]', { hasText: ADA })).toHaveCount(1)

  await page.goto(`/t/${tenantIdOf(page)}/account`)
  await expect(page.getByRole('main')).toContainText('You sign in with Dex SSO. This account has no password here.')
  await expect(page.getByRole('button', { name: 'Change password' })).toHaveCount(0)
  await page.context().close()
})

test('nobody else gets in: no invitation, or an account outside the domain', async ({ browser }) => {
  const page = await newDevice(browser)
  await page.goto('/sso')
  await page.getByLabel('Work email').fill(CY)
  await page.getByRole('button', { name: 'Continue' }).click()
  await dexSignIn(page, CY)
  await expect(page.getByRole('heading', { name: "Couldn't sign you in" })).toBeVisible()
  await expect(page.getByText(`There is no account for ${CY} here. Ask your admin for an invitation.`)).toBeVisible()

  // Started as Ben, but signed in at the provider as someone outside sso.test.
  await page.getByRole('link', { name: 'Try again' }).click()
  await page.getByLabel('Work email').fill(BEN.email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await dexSignIn(page, EVE)
  await expect(page.getByText("vouched for an account this sign-in doesn't cover")).toBeVisible()

  // A domain without SSO is told so before leaving.
  await page.goto('/sso')
  await page.getByLabel('Work email').fill('someone@acme.test')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText("Single sign-on isn't set up for acme.test")).toBeVisible()
  await page.context().close()
})

test('required: passwords stop working for the domain (owners excepted), with a way through', async ({ page, browser }) => {
  await signInAsOwner(page)
  await page.goto(settingsUrl)
  const card = page.getByRole('listitem', { name: 'Dex SSO' })
  await card.getByRole('button', { name: 'Require for these domains' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Require' }).click()
  await expect(card.getByText('Required', { exact: true })).toBeVisible()

  const ben = await newDevice(browser)
  await ben.goto('/login')
  await ben.getByLabel('Email', { exact: true }).fill(BEN.email)
  await ben.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await ben.getByRole('button', { name: 'Sign in' }).click()
  await expect(ben.getByText('Your organization signs in with Dex SSO')).toBeVisible()
  await ben.getByRole('link', { name: 'Continue with SSO' }).click()
  await expect(ben.getByLabel('Work email')).toHaveValue(BEN.email)
  await ben.getByRole('button', { name: 'Continue' }).click()
  await dexSignIn(ben, BEN.email)
  await expect(ben).toHaveURL(/\/t\//)

  // The owner keeps a password, in case the provider is down.
  const owner = await newDevice(browser)
  await signIn(owner, OWNER.email, OWNER.password)

  await page.goto(`/t/${tenantIdOf(page)}/org/audit?category=security`)
  const main = page.getByRole('main')
  await expect(main).toContainText('required single sign-on with Dex SSO')
  await expect(main).toContainText('signed in with Dex SSO for the first time, as ben@sso.test')
  await expect(main).toContainText(`failed to sign in with Dex SSO: no account or invitation for ${CY}`)
  await Promise.all([ben, owner].map((p) => p.context().close()))
})
