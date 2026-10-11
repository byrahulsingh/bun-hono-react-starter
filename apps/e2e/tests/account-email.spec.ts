/**
 * The sign-in email, and the emails about it: a sign-in from a new browser
 * (and its "This wasn't me" link), and changing the address. Each test has
 * its own person.
 */

import {
  PASSWORD,
  addPerson,
  expect,
  linkIn,
  mailTo,
  newDevice,
  ownerApi,
  runId,
  signIn,
  tenantIdOf,
  test,
} from './support'

const NEW_DEVICE = 'New sign-in to your account'

test("a new browser is reported; \"This wasn't me\" signs it out", async ({ page, browser }) => {
  const id = runId()
  const me = { email: `nico-${id}@acme.test`, name: `Nico ${id}` }
  await addPerson(await ownerApi(), { ...me, role: 'Admin', tenantId: null })

  // The first browser is not reported; a second one (its own storage) is.
  await signIn(page, me.email, PASSWORD)
  const again = await newDevice(browser)
  await signIn(again, me.email, PASSWORD)

  const mail = await mailTo(me.email, NEW_DEVICE)
  expect(mail.Text).toContain('Chrome on')

  // Opened from the email, on yet another device (no sign-in needed).
  const phone = await newDevice(browser)
  await phone.goto(linkIn(mail, '/sign-in-alert'))
  await expect(phone).toHaveURL(/\/sign-in-alert$/) // the token left the address bar
  await expect(phone.getByRole('heading', { name: 'Not you?' })).toBeVisible()
  await expect(phone.getByText(/^Chrome on/)).toBeVisible()
  await phone.getByRole('button', { name: 'Sign out that device' }).click()
  await expect(phone.getByRole('heading', { name: 'That device is signed out' })).toBeVisible()

  await again.goto('/')
  await expect(again).toHaveURL(/\/login/)
  // The browser that signed in first was never touched.
  await page.reload()
  await expect(page).toHaveURL(/\/t\//)
  await Promise.all([again, phone].map((p) => p.context().close()))
})

test('changing the sign-in email: link to the new address, notice to the old', async ({ page }) => {
  const id = runId()
  const me = { email: `olga-${id}@acme.test`, name: `Olga ${id}` }
  const next = `olga.new-${id}@acme.test`
  await addPerson(await ownerApi(), { ...me, role: 'Admin', tenantId: null })
  await signIn(page, me.email, PASSWORD)
  await page.goto(`/t/${tenantIdOf(page)}/account`)

  const section = page.locator('section', { hasText: 'Sign-in email' })
  await expect(section).toContainText(me.email)
  await section.getByRole('button', { name: 'Change email' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('New email').fill(next)
  await dialog.getByLabel('Password').fill('not my password')
  await dialog.getByRole('button', { name: 'Send confirmation link' }).click()
  await expect(dialog).toContainText('Incorrect password')
  await dialog.getByLabel('Password').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Send confirmation link' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(section).toContainText(`Waiting for confirmation: we sent a link to ${next}`)

  await page.goto(linkIn(await mailTo(next, 'Confirm your new sign-in email'), '/confirm-email'))
  await page.getByRole('button', { name: 'Use this email' }).click()
  await expect(page.getByRole('heading', { name: 'Email changed' })).toBeVisible()
  await expect(page.getByText(`You now sign in with ${next}`)).toBeVisible()
  expect((await mailTo(me.email, 'Your sign-in email was changed')).Text).toContain('o…@acme.test')

  await page.getByRole('link', { name: 'Continue' }).click()
  await expect(page.locator('[data-sidebar=menu-button]', { hasText: next })).toHaveCount(1)
})
