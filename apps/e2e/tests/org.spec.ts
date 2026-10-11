/**
 * The organization area: tenants (add, rename, archive, restore; the Main
 * tenant is never archived) and admins (invite, promote, remove).
 */

import {
  OWNER,
  PASSWORD,
  chooseRole,
  expect,
  expectNoCookies,
  linkIn,
  mailTo,
  navItems,
  newDevice,
  openSwitcher,
  row,
  rowAction,
  rowActions,
  runId,
  signInAsOwner,
  switcher,
  test,
} from './support'

test('tenants: add, rename, archive the current one, restore', async ({ page }) => {
  const id = runId()
  await signInAsOwner(page)
  const mainPath = new URL(page.url()).pathname
  const nav = await navItems(page)
  expect(nav).toContain('Tenants')
  expect(nav).toContain('Admins')

  await page.goto(`${mainPath}/org/tenants`)
  await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText('Organization')
  await expect(row(page, OWNER.org).first()).toContainText('Current')

  await page.getByRole('button', { name: 'Add tenant' }).click()
  await page.getByRole('dialog').getByLabel('Name').fill(`Gamma ${id}`)
  await page.getByRole('dialog').getByRole('button', { name: 'Create tenant' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).not.toHaveURL(new RegExp(`${mainPath}$`))
  const gammaPath = new URL(page.url()).pathname
  await page.goto(`${gammaPath}/org/tenants`)

  // Renaming to a name in use (ignoring case) is refused on the field.
  await rowAction(page, `Gamma ${id}`, 'Rename')
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill(OWNER.org.toLowerCase())
  await dialog.getByRole('button', { name: /save|rename/i }).click()
  await expect(dialog).toContainText('A tenant with this name already exists.')
  await dialog.getByLabel('Name').fill(`Gamma Clients ${id}`)
  await dialog.getByRole('button', { name: /save|rename/i }).click()
  await expect(dialog).toHaveCount(0)
  await expect(switcher(page)).toHaveAttribute('title', `Gamma Clients ${id}`)

  // The Main tenant: first, tagged, and it can be renamed but never archived.
  const first = page.getByRole('row').nth(1)
  await expect(first).toContainText(OWNER.org)
  await expect(first).toContainText('Main')
  expect(await rowActions(page, OWNER.org)).toEqual(['Rename'])

  // Archiving the tenant you are in takes you to another one.
  await rowAction(page, `Gamma Clients ${id}`, 'Archive')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click()
  await expect(page).toHaveURL(new RegExp(`${mainPath}$`))
  await expect(switcher(page)).toHaveAttribute('title', OWNER.org)
  const menu = await openSwitcher(page)
  expect(menu.some((t) => t.includes(`Gamma Clients ${id}`))).toBe(false)
  expect(menu[0]).toContain('Main')
  await page.keyboard.press('Escape')

  await page.goto(`${mainPath}/org/tenants`)
  await expect(row(page, `Gamma Clients ${id}`)).toContainText('Archived')
  await rowAction(page, `Gamma Clients ${id}`, 'Restore')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore' }).click()
  await expect(row(page, `Gamma Clients ${id}`)).not.toContainText('Archived')
  await expectNoCookies(page)
})

test('admins: invite, accept, promote, remove the role', async ({ page, browser }) => {
  const id = runId()
  const adaEmail = `ada-${id}@acme.test`
  await signInAsOwner(page)
  const mainPath = new URL(page.url()).pathname

  await page.goto(`${mainPath}/org/admins`)
  await expect(page.getByText('Organization roles')).toBeVisible()
  await expect(row(page, OWNER.name)).toContainText('(you)')
  await expect(row(page, OWNER.name)).not.toContainText('Never') // last sign-in shown
  expect(await rowActions(page, OWNER.name)).toEqual([])

  await page.getByRole('button', { name: 'Invite admin' }).click()
  await page.getByLabel('Emails').fill(adaEmail)
  await chooseRole(page, 'Admin')
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByRole('cell', { name: adaEmail })).toBeVisible()

  const ada = await newDevice(browser)
  await ada.goto(linkIn(await mailTo(adaEmail, 'invited you'), 'invite'))
  await expect(ada.getByText('as Admin')).toBeVisible()
  await ada.getByLabel('Your name').fill(`Ada ${id}`)
  await ada.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await ada.getByLabel('Confirm password').fill(PASSWORD)
  await ada.getByRole('button', { name: 'Create account' }).click()
  await expect(ada).toHaveURL(/\/t\//)
  expect(await navItems(ada)).toContain('Admins')
  await ada.goto(`${mainPath}/org/admins`)
  await expect(ada.getByText('Organization roles')).toBeVisible()
  expect(await rowActions(ada, OWNER.name)).toEqual([]) // an admin cannot touch the owner

  // The owner promotes Ada to Owner, then removes her organization role.
  await page.reload()
  await rowAction(page, `Ada ${id}`, 'Change role')
  await chooseRole(page, 'Owner')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(row(page, `Ada ${id}`)).toContainText('Owner')

  await rowAction(page, `Ada ${id}`, 'Remove organization role')
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('no access until invited')
  await confirm.getByRole('button', { name: 'Remove role' }).click()
  await expect(row(page, `Ada ${id}`)).toHaveCount(0)

  await ada.goto('/')
  await expect(ada.getByText('No workspace yet')).toBeVisible()
  await expectNoCookies(ada)
  await ada.context().close()
})
