/**
 * Two-factor sign-in, end to end: turning it on (QR, first code, recovery
 * codes), the code step at sign-in, recovery codes, the organization rule
 * (set up at sign-in), and an admin's reset. Uses its own admins, and puts
 * the rule back to "nobody" afterwards, so other specs are untouched.
 */

import type { Page } from '@playwright/test'

import {
  PASSWORD,
  addPerson,
  expect,
  mailTo,
  newDevice,
  ownerApi,
  row,
  rowAction,
  runId,
  signIn,
  signInAsOwner,
  sql,
  test,
  totp,
} from './support'

test.describe.configure({ mode: 'serial' })

const id = runId()
const tess = { email: `tess-${id}@acme.test`, name: `Tess ${id}` }
const uma = { email: `uma-${id}@acme.test`, name: `Uma ${id}` }
let mainId: string
let secret = ''
let recoveryCodes: string[] = []

/**
 * Each code works once, and only one newer than the last accepted: the next
 * unused 30-second step, waiting for it to come round when needed (the
 * server accepts one step either side of now).
 */
let lastStep = -1
async function nextCode(): Promise<string> {
  for (;;) {
    const now = Math.floor(Date.now() / 30_000)
    const step = Math.max(lastStep + 1, now)
    if (step <= now + 1) {
      lastStep = step
      return totp(secret, step - now)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

test.beforeAll(async () => {
  const api = await ownerApi()
  mainId = await api.mainTenantId()
  await addPerson(api, { ...tess, role: 'Admin', tenantId: null })
  await addPerson(api, { ...uma, role: 'Admin', tenantId: null })
})

test.afterAll(() => {
  // Whatever happened above, leave the organization's rule as other specs expect it.
  sql(`update organization set two_factor_policy = 'off'`)
})

/** The password step; the code step should follow. */
async function passwordStep(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** The setup key under the QR code, for "typing it into the app". */
async function readSetupKey(page: Page) {
  await page.getByText("Can't scan? Enter a key instead").click()
  return (await page.getByLabel('Setup key').textContent())!.replace(/\s/g, '')
}

test('turning it on: password, QR code, first code, recovery codes shown once', async ({ page }) => {
  await signIn(page, tess.email, PASSWORD)
  await page.goto(`/t/${mainId}/account`)
  const section = page.locator('section', { hasText: 'Two-factor sign-in' })
  await expect(section).toContainText('Off. Signing in needs only your password.')
  await section.getByRole('button', { name: 'Turn on' }).click()

  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Password').fill('not my password')
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog).toContainText('Incorrect password')
  await dialog.getByLabel('Password').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Continue' }).click()

  await expect(dialog.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible()
  secret = await readSetupKey(page)
  expect(secret).toMatch(/^[A-Z2-7]{32}$/)
  await dialog.getByLabel('Code from your app').fill('000000')
  await dialog.getByRole('button', { name: 'Turn on' }).click()
  await expect(dialog).toContainText('Incorrect code')
  await dialog.getByLabel('Code from your app').fill(await nextCode())
  await dialog.getByRole('button', { name: 'Turn on' }).click()

  const list = dialog.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')
  await expect(list).toHaveCount(10)
  recoveryCodes = await list.allTextContents()
  const done = dialog.getByRole('button', { name: 'Done' })
  await expect(done).toBeDisabled() // until they say the codes are saved
  await dialog.getByText("I've saved these codes").click()
  await done.click()
  await expect(dialog).toHaveCount(0)
  await expect(section).toContainText('On')
  await expect(section).toContainText('10 recovery codes left')
  await mailTo(tess.email, 'Two-factor sign-in is on')
})

test('signing in asks for a code; a recovery code works once and is reported', async ({ browser }) => {
  const laptop = await newDevice(browser)
  await passwordStep(laptop, tess.email)
  await expect(laptop.getByRole('heading', { name: 'Two-factor sign-in' })).toBeVisible()
  await laptop.getByLabel('Code from your app').fill('000000')
  await laptop.getByRole('button', { name: 'Continue' }).click()
  await expect(laptop.getByText('Incorrect code')).toBeVisible()
  // A fresh code: the one that turned it on cannot be used again.
  await laptop.getByLabel('Code from your app').fill(await nextCode())
  await laptop.getByRole('button', { name: 'Continue' }).click()
  await expect(laptop).toHaveURL(/\/t\//)

  const phone = await newDevice(browser)
  await passwordStep(phone, tess.email)
  await phone.getByRole('button', { name: 'Use a recovery code' }).click()
  await phone.getByLabel('Recovery code').fill(recoveryCodes[0]!)
  await phone.getByRole('button', { name: 'Continue' }).click()
  await expect(phone).toHaveURL(/\/t\//)
  expect((await mailTo(tess.email, 'A recovery code was used')).Text).toContain('9 recovery codes left')

  // The same recovery code again: refused.
  const tablet = await newDevice(browser)
  await passwordStep(tablet, tess.email)
  await tablet.getByRole('button', { name: 'Use a recovery code' }).click()
  await tablet.getByLabel('Recovery code').fill(recoveryCodes[0]!)
  await tablet.getByRole('button', { name: 'Continue' }).click()
  await expect(tablet.getByText('Incorrect code')).toBeVisible()
  await Promise.all([laptop, phone, tablet].map((p) => p.context().close()))
})

test('the rule: owners and admins set it up at their next sign-in, and cannot turn it off', async ({ browser }) => {
  // Tess (an admin, with two-factor) requires it for organization roles.
  const tessPage = await newDevice(browser)
  await passwordStep(tessPage, tess.email)
  await tessPage.getByLabel('Code from your app').fill(await nextCode())
  await tessPage.getByRole('button', { name: 'Continue' }).click()
  await expect(tessPage).toHaveURL(/\/t\//)
  await tessPage.goto(`/t/${mainId}/org/settings?tab=security`)
  await tessPage.getByText('Owners and admins').click()
  await tessPage.getByRole('button', { name: 'Save' }).click()
  await expect(tessPage.getByText('Security settings saved')).toBeVisible()

  // Uma (an admin, without) is walked through setup before she gets in.
  const umaPage = await newDevice(browser)
  await passwordStep(umaPage, uma.email)
  await expect(umaPage.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible()
  const umaSecret = await readSetupKey(umaPage)
  await umaPage.getByLabel('Code from your app').fill(totp(umaSecret))
  await umaPage.getByRole('button', { name: 'Turn on' }).click()
  await expect(umaPage.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible()
  await umaPage.getByText("I've saved these codes").click()
  await umaPage.getByRole('button', { name: 'Continue' }).click()
  await expect(umaPage).toHaveURL(/\/t\//)

  // Required for her: it stays on.
  await umaPage.goto(`/t/${mainId}/account`)
  const section = umaPage.locator('section', { hasText: 'Two-factor sign-in' })
  await expect(section.getByRole('button', { name: 'Turn off' })).toBeDisabled()
  await expect(section).toContainText('Your organization requires two-factor sign-in')

  // Back to "nobody required".
  await tessPage.getByText('Nobody required').click()
  await tessPage.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => sql<{ p: string }>('select two_factor_policy as p from organization')[0]!.p).toBe('off')
  await Promise.all([tessPage, umaPage].map((p) => p.context().close()))
})

test("an admin resets a lost phone: signed out everywhere, told by email, password alone works", async ({ page, browser }) => {
  const tessPage = await newDevice(browser)
  await passwordStep(tessPage, tess.email)
  await tessPage.getByLabel('Code from your app').fill(await nextCode())
  await tessPage.getByRole('button', { name: 'Continue' }).click()
  await expect(tessPage).toHaveURL(/\/t\//)

  await signInAsOwner(page)
  await page.goto(`/t/${mainId}/org/people`)
  await expect(row(page, tess.email)).toContainText('2FA')
  await rowAction(page, tess.name, 'Reset two-factor')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reset two-factor' }).click()
  await expect(row(page, tess.email)).not.toContainText('2FA')
  await mailTo(tess.email, 'Your two-factor sign-in was reset')

  await tessPage.goto(`/t/${mainId}`)
  await expect(tessPage).toHaveURL(/\/login/)
  await signIn(tessPage, tess.email, PASSWORD) // no code step any more

  await page.goto(`/t/${mainId}/org/audit?category=security`)
  await expect(page.getByRole('main')).toContainText('turned on two-factor sign-in')
  await expect(page.getByRole('main')).toContainText('signed in with a recovery code')
  await tessPage.context().close()
})
