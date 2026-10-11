/**
 * The audit log: entries as sentences, details, filters (category, person,
 * dates, tenant), paging, and who may see it.
 */

import type { Page } from '@playwright/test'

import {
  OWNER,
  PASSWORD,
  addPerson,
  apiLogin,
  expect,
  expectNoCookies,
  navItems,
  newDevice,
  ownerApi,
  runId,
  signIn,
  signInAsOwner,
  test,
} from './support'

const entries = (page: Page) =>
  page.getByRole('main').locator('button[aria-controls^="audit-"]')
const entryTexts = async (page: Page) =>
  (await entries(page).allInnerTexts()).map((t) => t.replace(/\s+/g, ' '))

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

test('sentences, details, filters, dates, paging and access', async ({ page, browser }) => {
  const id = runId()
  const ed = { email: `ed-${id}@acme.test`, name: `Ed ${id}` }

  // Some history: a failed sign-in, a tenant renamed, an invitation accepted, a role change.
  expect((await apiLogin(OWNER.email, 'wrong password!')).status).toBe(401)
  const api = await ownerApi()
  const mainId = await api.mainTenantId()
  const betaId = await api.createTenant(`Beta ${id}`)
  await api.call('PATCH', `/tenants/${betaId}`, { name: `Beta Clients ${id}` })
  await addPerson(api, { ...ed, role: 'Editor', tenantId: mainId })
  const members = await api.call<{ email: string; user_id: string }[]>('GET', `/t/${mainId}/members`)
  const edId = members.find((m) => m.email === ed.email)!.user_id
  await api.call('PATCH', `/t/${mainId}/members/${edId}`, {
    role_id: await api.roleId(`t/${mainId}`, 'Viewer'),
  })

  await signInAsOwner(page)
  await page.goto(`/t/${mainId}/org/audit`)
  await expect(page.getByText('Today')).toBeVisible()
  const list = await entryTexts(page)
  const has = (needle: string) => list.some((r) => r.includes(needle))
  expect(has(`${OWNER.name} changed ${ed.name}'s role to Viewer`)).toBe(true)
  expect(has(`${OWNER.name} renamed tenant Beta ${id} to Beta Clients ${id}`)).toBe(true)
  expect(has(`${OWNER.name} invited ${ed.email} as Editor`)).toBe(true)
  expect(has(`${ed.name} accepted an invitation`)).toBe(true)
  expect(has(OWNER.org)).toBe(true) // the tenant, on tenant events

  // ── Details ──
  await entries(page).filter({ hasText: `${ed.name}'s role` }).first().click()
  const details = page.getByRole('main').locator('li > [id^=audit-]').first()
  await expect(details).toContainText('membership.role_changed')
  await expect(details).toContainText('IP address')
  await expect(details).toContainText('Request ID')
  await expect(details).toContainText('to_role_id')

  // ── Filters (in the URL) ──
  await page.goto(`/t/${mainId}/org/audit?category=tenants`)
  await expect(entries(page).first()).toBeVisible()
  for (const text of await entryTexts(page)) expect(text).toContain('tenant')
  await expect(page.locator('#audit-category')).toContainText('Tenants')

  await page.goto(`/t/${mainId}/org/audit?category=account`)
  await expect(page.getByRole('main')).toContainText(`${OWNER.name} set up the organization`)

  await page.goto(`/t/${mainId}/org/audit?category=security`)
  const warning = entries(page).filter({ hasText: `failed to sign in as ${OWNER.email}` }).first()
  await expect(warning).toBeVisible()
  await expect(warning.getByLabel('Security event')).toBeVisible()

  await page.goto(`/t/${mainId}/org/audit?actor=${edId}`)
  await expect(entries(page).first()).toBeVisible()
  const edList = await entryTexts(page)
  expect(edList.length).toBeGreaterThanOrEqual(2)
  for (const text of edList) expect(text).toContain(ed.name)

  const tomorrow = ymd(new Date(Date.now() + 86_400_000))
  await page.goto(`/t/${mainId}/org/audit?from=${tomorrow}`)
  await expect(page.getByText('Nothing matches these filters.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear' }).click()
  await expect(page).toHaveURL(/\/org\/audit$/)
  await expect(entries(page).nth(5)).toBeVisible()

  // ── Dates ──
  const today = ymd(new Date())
  const weekAgo = ymd(new Date(Date.now() - 6 * 86_400_000))
  const dates = page.locator('#audit-dates')
  const calendar = page.locator('[data-slot=popover-content]')
  await expect(dates).toHaveText('Any time')
  await dates.click()
  const future = calendar.locator(`[data-day="${tomorrow}"]`)
  if (await future.count()) await expect(future).toHaveAttribute('data-disabled')
  await calendar.getByRole('button', { name: 'Last 7 days' }).click()
  await expect(page).toHaveURL(new RegExp(`from=${weekAgo}.*to=${today}|to=${today}.*from=${weekAgo}`))
  await expect(calendar).toHaveCount(0)
  await expect(dates).toContainText('–')

  const firstOfMonth = `${today.slice(0, 8)}01`
  if (firstOfMonth !== today) {
    await dates.click()
    // Two months are shown; a day at a month's edge appears in both. This month is the last grid.
    const day = (d: string) => calendar.getByRole('grid').last().locator(`[data-day="${d}"]`)
    await day(firstOfMonth).locator('button').click()
    await day(today).locator('button').click()
    await expect(day(firstOfMonth)).toHaveAttribute('data-selected')
    await expect(day(today)).toHaveAttribute('data-selected')
    await calendar.getByRole('button', { name: 'Apply' }).click()
    await expect(page).toHaveURL(new RegExp(`from=${firstOfMonth}`))

    // Escape throws the draft away; the applied range stays.
    await dates.click()
    await day(today).locator('button').click()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(new RegExp(`from=${firstOfMonth}`))
  }
  await dates.click()
  await calendar.getByRole('button', { name: 'Clear' }).click()
  await expect(page).not.toHaveURL(/from=/)
  await expect(dates).toHaveText('Any time')

  // ── Paging: one tenant's history, longer than a page ──
  for (let i = 0; i < 55; i++) {
    await api.call('PATCH', `/tenants/${betaId}`, { name: `Beta ${id} ${i}` })
  }
  await page.goto(`/t/${mainId}/org/audit?tenant=${betaId}`)
  await expect(entries(page)).toHaveCount(50)
  await page.getByRole('button', { name: 'Load older entries' }).click()
  await expect(entries(page)).toHaveCount(57) // created, renamed, and 55 more renames
  const ids = await entries(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-controls')))
  expect(new Set(ids).size).toBe(ids.length)
  await expect(page.getByRole('button', { name: 'Load older entries' })).toHaveCount(0)

  // ── Access: a viewer has no audit log ──
  const edPage = await newDevice(browser)
  await signIn(edPage, ed.email, PASSWORD)
  expect(await navItems(edPage)).not.toContain('Audit log')
  await edPage.goto(`/t/${mainId}/org/audit`)
  await expect(edPage.getByText('No access')).toBeVisible()

  await expectNoCookies(page)
  await edPage.context().close()
})
