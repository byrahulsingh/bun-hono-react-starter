/**
 * The Account page: profile, password, and the devices you are signed in on.
 * Its own person, so changing the password never affects other specs.
 */

import type { Page } from '@playwright/test'

import {
  PASSWORD,
  addPerson,
  expect,
  expectNoCookies,
  newDevice,
  ownerApi,
  runId,
  signIn,
  test,
} from './support'

const devices = (page: Page) =>
  page.locator('section', { hasText: "Where you're signed in" }).getByRole('listitem')

test('profile, devices and password', async ({ page, browser }) => {
  const id = runId()
  const me = { email: `ana-${id}@acme.test`, name: `Ana ${id}` }
  const NEW_PASSWORD = 'an even better password'
  await addPerson(await ownerApi(), { ...me, role: 'Admin', tenantId: null })

  // Device A (this test's page) and device B (another computer).
  await signIn(page, me.email, PASSWORD)
  const b = await newDevice(browser)
  await signIn(b, me.email, PASSWORD)

  // The user menu holds Account and Sign out, nothing else.
  await page.mouse.move(30, 860)
  await page.locator('[data-sidebar=menu-button]', { hasText: me.email }).click()
  expect((await page.getByRole('menuitem').allTextContents()).map((t) => t.trim())).toEqual(['Account', 'Sign out'])
  await page.getByRole('menuitem', { name: 'Account' }).click()

  await expect(devices(page)).toHaveCount(2)
  await expect(devices(page).filter({ hasText: 'This device' })).toHaveCount(1)
  for (const text of await devices(page).allInnerTexts()) expect(text).toMatch(/^Chrome on (macOS|Linux|Windows)/)

  // ── Profile ──
  await page.getByLabel('Name', { exact: true }).fill(`Ana K. ${id}`)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('[data-sidebar=menu-button]', { hasText: `Ana K. ${id}` })).toHaveCount(1)

  // ── A wrong current password is refused on the field ──
  await page.getByLabel('Current password').fill('not my password')
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Incorrect password')).toBeVisible()

  // ── End device B from here ──
  await devices(page).filter({ hasNotText: 'This device' }).getByRole('button', { name: 'Sign out' }).click()
  await expect(devices(page)).toHaveCount(1)
  await b.goto('/')
  await expect(b).toHaveURL(/\/login/)
  await expect(b.getByText('Your session ended')).toBeVisible()

  // ── Changing the password keeps this device and ends the others ──
  await signIn(b, me.email, PASSWORD)
  await page.reload()
  await expect(devices(page)).toHaveCount(2)
  await page.getByLabel('Current password').fill(PASSWORD)
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password changed')).toBeVisible()
  await expect(devices(page)).toHaveCount(1)
  await expect(page.getByLabel('Current password')).toHaveValue('')
  await b.goto('/')
  await expect(b).toHaveURL(/\/login/)
  await signIn(b, me.email, NEW_PASSWORD)

  // ── Sign out on this device: back to a plain login page ──
  await page.reload()
  await devices(page).filter({ hasText: 'This device' }).getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expectNoCookies(page)
  await b.context().close()
})
