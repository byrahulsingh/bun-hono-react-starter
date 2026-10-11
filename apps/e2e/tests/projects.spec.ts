/**
 * The example module, in the browser: create, edit, delete, with the field
 * errors and audit entries; and a viewer who can only read.
 */

import {
  PASSWORD,
  addPerson,
  expect,
  newDevice,
  ownerApi,
  row,
  rowAction,
  rowActions,
  runId,
  signIn,
  signInAsOwner,
  tenantIdOf,
  test,
} from './support'

test('an owner creates, edits and deletes a project', async ({ page }) => {
  const name = `Website ${runId()}`
  await signInAsOwner(page)
  await page.locator('[data-sidebar=menu-button]', { hasText: 'Projects' }).click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(dialog.getByText('Required')).toBeVisible() // checked before it is sent
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Description').fill('The new site')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(page, name)).toContainText('The new site')
  await expect(row(page, name)).toContainText('Active')

  // The same name again, in other case: refused by the server, on the field.
  await page.getByRole('button', { name: 'New project' }).click()
  await dialog.getByLabel('Name').fill(name.toUpperCase())
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(dialog.getByText('A project with this name already exists here.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await rowAction(page, name, 'Edit')
  await expect(dialog.getByLabel('Name')).toHaveValue(name)
  await dialog.locator('#status').click()
  await page.getByRole('option', { name: 'Done' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(page, name)).toContainText('Done')

  await rowAction(page, name, 'Delete')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
  await expect(row(page, name)).toHaveCount(0)

  await page.goto(`/t/${tenantIdOf(page)}/org/audit`)
  const main = page.getByRole('main')
  await expect(main).toContainText(`created project ${name}`)
  await expect(main).toContainText(`set project ${name} to Done`)
  await expect(main).toContainText(`deleted project ${name}`)
})

test('a viewer sees projects but cannot change them', async ({ page, browser }) => {
  const id = runId()
  const name = `Shop ${id}`
  const viewer = { email: `vi-${id}@acme.test`, name: `Vi ${id}` }
  await signInAsOwner(page)
  const tenantId = tenantIdOf(page)
  const api = await ownerApi()
  await api.call('POST', `/t/${tenantId}/projects`, { name })
  await addPerson(api, { ...viewer, role: 'Viewer', tenantId })

  const other = await newDevice(browser)
  await signIn(other, viewer.email, PASSWORD)
  await other.goto(`/t/${tenantId}/projects`)
  await expect(row(other, name)).toContainText('Active')
  await expect(other.getByRole('button', { name: 'New project' })).toHaveCount(0)
  expect(await rowActions(other, name)).toEqual([])
  await other.context().close()
})
