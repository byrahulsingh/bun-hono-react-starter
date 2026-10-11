/**
 * The roles editor: built-ins are read-only, custom roles follow the tick
 * rules, unsaved changes are guarded, a role in use cannot be deleted, and
 * nobody can hand out a permission they do not hold.
 */

import type { Page } from '@playwright/test'

import {
  PASSWORD,
  addPerson,
  chooseRole,
  expect,
  expectNoCookies,
  newDevice,
  ownerApi,
  row,
  rowAction,
  rowActions,
  runId,
  signIn,
  signInAsOwner,
  test,
} from './support'

/** The checkbox of the permission (or module) whose label is exactly `label`. */
const box = (page: Page, label: string) =>
  page
    .locator('form label')
    .filter({ hasText: new RegExp(`^${label.replace(/[/()]/g, '\\$&')}$`) })
    .locator('[data-slot=checkbox]')

async function expectTicked(page: Page, label: string, ticked: boolean) {
  if (ticked) await expect(box(page, label)).toHaveAttribute('data-checked')
  else await expect(box(page, label)).not.toHaveAttribute('data-checked')
}

test('built-in roles are read-only; custom roles follow the rules', async ({ page }) => {
  const id = runId()
  const planner = `Planner ${id}`
  const lead = `Team lead ${id}`
  await signInAsOwner(page)
  const tenantPath = new URL(page.url()).pathname

  await page.goto(`${tenantPath}/org/roles`)
  await expect(page.getByText('Tenant roles')).toBeVisible()
  const builtIns = await page.getByRole('row').getByRole('link').allTextContents()
  expect(builtIns.slice(0, 5)).toEqual(['Owner', 'Admin', 'Manager', 'Editor', 'Viewer'])
  await expect(row(page, 'Owner').first()).toContainText(/\d+ (person|people)/)
  expect(await rowActions(page, 'Viewer')).toEqual(['View', 'Duplicate'])

  // ── A built-in: locked ──
  await page.getByRole('link', { name: 'Viewer', exact: true }).click()
  await expect(page.getByText('Built-in roles are locked')).toBeVisible()
  await expectTicked(page, 'See projects', true)
  await expect(box(page, 'See projects')).toHaveAttribute('data-disabled')
  await expect(page.getByRole('button', { name: 'Save role' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back' }).click()

  // ── A new role, with the tick rules ──
  await page.getByRole('link', { name: 'New role' }).click()
  await expect(box(page, 'Audit log')).toHaveCount(0) // tenant roles: no organization permissions
  await page.getByLabel('Name').fill(planner)
  await page.getByRole('button', { name: 'Create role' }).click()
  await expect(page.getByText('Choose at least one permission.')).toBeVisible()

  await box(page, 'Add / remove people').click()
  await expectTicked(page, 'See tenant people', true) // what it needs comes along
  await box(page, 'See tenant people').click()
  await expectTicked(page, 'Add / remove people', false) // and goes with it
  await box(page, 'Add / remove people').click()
  await page.locator('[data-slot=checkbox][aria-label="All of Projects"]').click()
  await expectTicked(page, 'Delete projects', true)
  await expectTicked(page, 'Create projects', true)
  await expect(page.getByText('6 permissions')).toBeVisible()

  // Leaving with unsaved changes asks first; "Keep editing" loses nothing.
  await page.locator('[data-sidebar=menu-button]', { hasText: 'Dashboard' }).click()
  const discard = page.getByRole('alertdialog')
  await expect(discard).toContainText('Discard your changes?')
  await discard.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page).toHaveURL(/\/org\/roles\/new$/)
  await expectTicked(page, 'Delete projects', true)

  await page.getByRole('button', { name: 'Create role' }).click()
  await expect(page).toHaveURL(/\/org\/roles$/)
  await expect(row(page, planner)).toContainText('6')
  await expect(page.getByRole('alertdialog')).toHaveCount(0) // saving is not "leaving"

  // ── Duplicate a built-in ──
  await rowAction(page, 'Manager', 'Duplicate')
  await expect(page.getByLabel('Name')).toHaveValue('Copy of Manager')
  await expectTicked(page, 'Add / remove people', true)
  await page.getByLabel('Name').fill(lead)
  await page.getByRole('button', { name: 'Create role' }).click()
  await expect(row(page, lead)).toBeVisible()

  // ── A role in use cannot be deleted; an unused one can ──
  await page.goto(`${tenantPath}/people`)
  await page.getByRole('button', { name: 'Invite person' }).click()
  await page.getByLabel('Emails').fill(`src-${id}@acme.test`)
  await chooseRole(page, planner)
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.goto(`${tenantPath}/org/roles`)
  await expect(row(page, planner)).toContainText('1 invitation')
  expect(await rowActions(page, planner)).not.toContain('Delete')
  await rowAction(page, lead, 'Delete')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete role' }).click()
  await expect(row(page, lead)).toHaveCount(0)
  await expectNoCookies(page)
})

test('an admin sees what they cannot give; unsaved work is guarded by the browser too', async ({ browser }) => {
  const id = runId()
  const ada = { email: `ada-${id}@acme.test`, name: `Ada ${id}` }
  const api = await ownerApi()
  const mainId = await api.mainTenantId()
  await addPerson(api, { ...ada, role: 'Admin', tenantId: null })

  const adaPage = await newDevice(browser)
  await signIn(adaPage, ada.email, PASSWORD)
  await adaPage.goto(`/t/${mainId}/org/roles/new`)
  await adaPage.getByText('The whole organization').click()
  await expect(box(adaPage, 'Billing and usage')).toHaveAttribute('data-disabled')
  await expect(box(adaPage, 'Audit log')).not.toHaveAttribute('data-disabled')

  // Leaving by URL with unsaved changes: the browser's own "Leave site?" prompt.
  let prompted = false
  adaPage.once('dialog', async (dialog) => {
    prompted = dialog.type() === 'beforeunload'
    await dialog.accept()
  })
  await adaPage.locator('form input[name=name]').fill('Draft')
  await adaPage.goto(`/t/${mainId}/org/roles`)
  expect(prompted).toBe(true)

  await adaPage.getByRole('link', { name: 'Owner', exact: true }).click()
  await expect(adaPage.getByText('Built-in roles are locked')).toBeVisible()
  await expect(adaPage.getByRole('button', { name: 'Save role' })).toHaveCount(0)
  await adaPage.context().close()
})
