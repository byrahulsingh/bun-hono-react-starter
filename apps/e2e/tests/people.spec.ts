/**
 * A tenant's People page: adding a tenant, inviting someone, what they can
 * and cannot do, changing their role, removing them.
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
  runId,
  signInAsOwner,
  switcher,
  test,
} from './support'

test('invite, accept, change role, remove', async ({ page, browser }) => {
  const id = runId()
  const tenant = `Beta ${id}`
  const edEmail = `ed-${id}@acme.test`

  await signInAsOwner(page)
  await expect(page.locator('[data-variant=inset]')).toHaveCount(1)
  expect(await navItems(page)).toContain('People')

  // ── Add a tenant from the switcher ──
  await openSwitcher(page)
  await page.getByRole('button', { name: 'Add tenant' }).click()
  const dialog = page.getByRole('dialog')
  // A name already taken, ignoring case, is refused on the field.
  await dialog.getByLabel('Name').fill(OWNER.org.toLowerCase())
  await dialog.getByRole('button', { name: /create|add/i }).click()
  await expect(dialog).toContainText('A tenant with this name already exists.')
  await dialog.getByLabel('Name').fill(tenant)
  await dialog.getByRole('button', { name: /create|add/i }).click()
  await expect(dialog).toHaveCount(0)
  await expect(switcher(page)).toHaveAttribute('title', tenant)
  const tenantPath = new URL(page.url()).pathname

  const menu = await openSwitcher(page)
  expect(menu[0]).toBe(`${OWNER.org[0]}${OWNER.org}MainOwner`)
  expect(menu).toContain(`B${tenant}Owner`)
  // Typing filters the list (the full name: other specs make "Beta …" tenants too).
  await page.getByRole('combobox', { name: 'Switch tenant' }).fill(tenant.toUpperCase())
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Add tenant' })).toBeVisible()
  await page.keyboard.press('Escape')

  // ── Invite ──
  await page.goto(`${tenantPath}/people`)
  await expect(page.getByText(`Everyone who can open ${tenant}`)).toBeVisible()
  await expect(row(page, OWNER.name)).toContainText('organization')
  await page.getByRole('button', { name: 'Invite person' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /Send/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Enter at least one email address')
  await page.getByLabel('Emails').fill(edEmail)
  await chooseRole(page, 'Editor')
  await expect(page.getByRole('dialog')).toContainText('Works with everything in their tenant')
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('cell', { name: edEmail })).toBeVisible()

  // ── Ed accepts, on another computer ──
  const link = linkIn(await mailTo(edEmail, 'invited you'), 'invite')
  const ed = await newDevice(browser)
  await ed.goto(link)
  await expect(ed.getByRole('heading', { name: `Join ${tenant}` })).toBeVisible()
  await ed.getByLabel('Your name').fill('Ed Editor')
  await ed.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await ed.getByLabel('Confirm password').fill(PASSWORD)
  await ed.getByRole('button', { name: 'Create account' }).click()
  await expect(ed).toHaveURL(new RegExp(`${tenantPath}$`))
  // Only his tenant, and no "Add tenant".
  expect(await openSwitcher(ed)).toEqual([`B${tenant}Editor`])
  await expect(ed.getByRole('button', { name: 'Add tenant' })).toHaveCount(0)
  await ed.keyboard.press('Escape')

  await ed.goto(`${tenantPath}/people`)
  await expect(ed.getByText('Everyone who can open')).toBeVisible()
  await expect(ed.getByRole('button', { name: 'Invite person' })).toHaveCount(0)
  await expect(ed.getByText('Invitations')).toHaveCount(0)
  await expect(ed.getByRole('button', { name: /^Actions for/ })).toHaveCount(0)

  // ── Owner changes Ed to Viewer ──
  await page.reload()
  await expect(row(page, 'Ed Editor')).toBeVisible()
  await expect(page.getByRole('cell', { name: edEmail, exact: true })).toHaveCount(0) // no longer an open invitation
  await rowAction(page, 'Ed Editor', 'Change role')
  await chooseRole(page, 'Viewer')
  await page.getByRole('dialog').getByRole('button', { name: /save|change/i }).click()
  await expect(row(page, 'Ed Editor')).toContainText('Viewer')

  // Ed's next load reflects it: People is gone from his sidebar.
  await ed.goto(tenantPath)
  await expect(ed.getByText('Welcome, Ed')).toBeVisible()
  expect(await navItems(ed)).not.toContain('People')

  // ── Owner removes Ed ──
  await rowAction(page, 'Ed Editor', 'Remove from tenant')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(row(page, 'Ed Editor')).toHaveCount(0)

  await ed.goto(tenantPath)
  await expect(ed.getByText(/Tenant not found|No workspace yet/)).toBeVisible()

  await expectNoCookies(page)
  await expectNoCookies(ed)
  await ed.context().close()
})
