/**
 * The People directory: everyone with an account, adding someone to another
 * tenant, emailing a reset link, deactivating and reactivating.
 */

import {
  OWNER,
  PASSWORD,
  addPerson,
  chooseRole,
  expect,
  expectNoCookies,
  mailTo,
  navItems,
  newDevice,
  openSwitcher,
  ownerApi,
  row,
  rowAction,
  rowActions,
  runId,
  signIn,
  signInAsOwner,
  test,
} from './support'

test('directory: add to tenant, reset link, deactivate, reactivate', async ({ page, browser }) => {
  const id = runId()
  const ed = { email: `ed-${id}@acme.test`, name: `Ed ${id}` }
  const ada = { email: `ada-${id}@acme.test`, name: `Ada ${id}` }
  const beta = `Beta ${id}`

  const api = await ownerApi()
  const mainId = await api.mainTenantId()
  await api.createTenant(beta)
  await addPerson(api, { ...ed, role: 'Editor', tenantId: mainId })
  await addPerson(api, { ...ada, role: 'Admin', tenantId: null })

  const edPage = await newDevice(browser)
  await signIn(edPage, ed.email, PASSWORD)

  await signInAsOwner(page)
  expect(await navItems(page)).toContain('Directory')
  await page.goto(`/t/${mainId}/org/people`)
  await expect(page.getByRole('heading', { name: 'People directory' })).toBeVisible()
  await expect(row(page, OWNER.email)).toContainText('every tenant')
  expect(await rowActions(page, OWNER.name)).toEqual([])
  await expect(row(page, ed.email)).toContainText(`${OWNER.org} · Editor`)
  expect(await rowActions(page, ed.name)).toEqual([
    'Add to tenant',
    'Send password reset link',
    'Deactivate account',
  ])
  expect(await rowActions(page, ada.name)).not.toContain('Add to tenant')

  const search = page.getByRole('searchbox')
  await search.fill(`ed-${id}`)
  await expect(page.getByRole('row')).toHaveCount(2) // header + Ed
  await search.fill('')

  // ── Add Ed to another tenant ──
  await rowAction(page, ed.name, 'Add to tenant')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Add to tenant' }).click()
  await expect(dialog).toContainText('Choose a tenant')
  await dialog.locator('#tenant_id').click()
  await page.getByRole('option', { name: beta }).click()
  await chooseRole(page, 'Viewer')
  await dialog.getByRole('button', { name: 'Add to tenant' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(page, ed.email)).toContainText(`${beta} · Viewer`)
  await mailTo(ed.email, `You now have access to ${beta}`)

  // ── Reset link ──
  await rowAction(page, ed.name, 'Send password reset link')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Send link' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect((await mailTo(ed.email, 'Reset your password')).Text).toContain('reset-password?token=')

  // ── Deactivate ──
  await rowAction(page, ed.name, 'Deactivate account')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Deactivate' }).click()
  await expect(row(page, ed.email)).toContainText('Deactivated')
  expect(await rowActions(page, ed.name)).toEqual(['Reactivate account'])
  await page.getByLabel('Account status').click()
  await page.getByRole('option', { name: 'Deactivated' }).click()
  await expect(row(page, ed.email)).toBeVisible()
  for (const text of await page.getByRole('row').allTextContents()) {
    if (text.includes('@')) expect(text).toContain('Deactivated')
  }

  // Ed's open browser: signed out on his next load, and refused at sign-in
  // with the same answer as a wrong password.
  await edPage.goto(`/t/${mainId}`)
  await expect(edPage).toHaveURL(/\/login/)
  await expect(edPage.getByText('Your session ended')).toBeVisible()
  await edPage.getByLabel('Email', { exact: true }).fill(ed.email)
  await edPage.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await edPage.getByRole('button', { name: 'Sign in' }).click()
  await expect(edPage.getByText('Email or password is incorrect')).toBeVisible()

  // The tenant's People page marks him too.
  await page.goto(`/t/${mainId}/people`)
  await expect(row(page, ed.email)).toContainText('Deactivated')

  // ── Reactivate: the same access comes back ──
  await page.goto(`/t/${mainId}/org/people`)
  await rowAction(page, ed.name, 'Reactivate account')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reactivate' }).click()
  await expect(row(page, ed.email)).not.toContainText('Deactivated')
  await edPage.getByRole('button', { name: 'Sign in' }).click()
  await expect(edPage).toHaveURL(/\/t\//)
  const menu = await openSwitcher(edPage)
  expect(menu).toHaveLength(2)
  await edPage.keyboard.press('Escape')

  // An admin cannot act on the owner.
  const adaPage = await newDevice(browser)
  await signIn(adaPage, ada.email, PASSWORD)
  await adaPage.goto(`/t/${mainId}/org/people`)
  await expect(adaPage.getByRole('heading', { name: 'People directory' })).toBeVisible()
  expect(await rowActions(adaPage, OWNER.name)).toEqual([])

  // The audit log tells the story.
  await page.goto(`/t/${mainId}/org/audit?category=people`)
  const main = page.getByRole('main')
  await expect(main).toContainText(`deactivated ${ed.name}'s account`)
  await expect(main).toContainText(`reactivated ${ed.name}'s account`)
  await expect(main).toContainText(`added ${ed.name} to the tenant as Viewer`)

  await expectNoCookies(page)
  await edPage.context().close()
  await adaPage.context().close()
})
