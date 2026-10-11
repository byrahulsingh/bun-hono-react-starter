/**
 * The app shell: an icon rail that peeks open on hover or keyboard focus,
 * pins open, the assistant panel, the phone drawer, and what is remembered
 * where (IndexedDB only; nothing in cookies or localStorage).
 */

import type { Page } from '@playwright/test'

import {
  OWNER,
  expect,
  expectNoCookies,
  openSwitcher,
  signInAsOwner,
  runId,
  test,
} from './support'

const width = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((e) => Math.round(e.getBoundingClientRect().width))
const left = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((e) => Math.round(e.getBoundingClientRect().x))
const RAIL = '[data-slot=sidebar-container]'
const PAGE = '[data-slot=sidebar-inset]'

/** A value from the app's preferences store in IndexedDB (`prefs/`). */
const pref = (page: Page, key: 'device' | 'person') =>
  page.evaluate(
    (k) =>
      new Promise((resolve) => {
        const open = indexedDB.open('prefs/')
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('prefs')) return resolve(null)
          const get = db.transaction('prefs').objectStore('prefs').get(k)
          get.onsuccess = () => resolve(get.result ?? null)
        }
      }),
    key,
  )

const localStorageKeys = (page: Page) =>
  page.evaluate(() =>
    // The TanStack devtools (development only) keep their own panel state.
    Object.keys(localStorage).filter((k) => !k.startsWith('tanstack_devtools')),
  )

async function openUserMenu(page: Page) {
  await page.mouse.move(30, 860)
  await page.locator('[data-sidebar=menu-button]', { hasText: OWNER.email }).click()
  await expect(page.getByRole('menu')).toBeVisible()
}

// Timing matters here (hover delays of 150 ms): recording a trace slows each
// action enough to blur the difference between a quick pass and a hover.
test.use({ trace: 'off' })

test('the rail: hover intent, peek over the page, menus, keyboard, pin', async ({ page }) => {
  await signInAsOwner(page)
  await page.mouse.move(900, 450)
  await expect.poll(() => width(page, RAIL)).toBeLessThan(80)
  const pageX = await left(page, PAGE)

  // A quick pass does not open it.
  await page.mouse.move(30, 300)
  await page.mouse.move(900, 300)
  await page.waitForTimeout(400)
  expect(await width(page, RAIL)).toBeLessThan(80)

  // Hover and stay: after a short delay it opens over the page, which does not move.
  await page.mouse.move(30, 300)
  await page.waitForTimeout(80)
  expect(await width(page, RAIL)).toBeLessThan(80)
  await expect.poll(() => width(page, RAIL)).toBeGreaterThan(250)
  expect(await left(page, PAGE)).toBe(pageX)
  await expect(page.locator('[data-slot=sidebar]')).toHaveAttribute('data-peek', 'true')
  await expect(page.locator('[data-sidebar=menu-button]', { hasText: 'Projects' })).toBeVisible()

  // Collapsing is smooth: no long frames while it animates.
  const frames = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const gaps: number[] = []
        let last = performance.now()
        const end = last + 700
        const tick = (now: number) => {
          gaps.push(now - last)
          last = now
          if (now < end) requestAnimationFrame(tick)
          else resolve(gaps.slice(1))
        }
        requestAnimationFrame(tick)
      }),
  )
  await page.mouse.move(900, 300)
  expect(Math.max(...(await frames))).toBeLessThan(60)
  await expect.poll(() => width(page, RAIL)).toBeLessThan(80)

  // A menu opened from the rail keeps it open while the pointer is in the menu.
  await openUserMenu(page)
  const menu = await page.getByRole('menu').boundingBox()
  await page.mouse.move(menu!.x + menu!.width / 2, menu!.y + menu!.height / 2)
  await page.waitForTimeout(500)
  expect(await width(page, RAIL)).toBeGreaterThan(250)
  await page.keyboard.press('Escape')
  await page.mouse.move(900, 300)
  await expect.poll(() => width(page, RAIL)).toBeLessThan(80)

  // Keyboard: Tab into the rail opens it; focus leaving closes it.
  await page.reload()
  await expect(page.getByText('Welcome')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-slot=sidebar]'))).toBe(true)
  await expect.poll(() => width(page, RAIL)).toBeGreaterThan(250)
  await page.getByRole('heading', { level: 1 }).click()
  await expect.poll(() => width(page, RAIL)).toBeLessThan(80)

  // Pinned: takes its room, remembered in IndexedDB, nothing in localStorage.
  await page.locator('[data-slot=sidebar-trigger]').click()
  await expect.poll(() => width(page, RAIL)).toBeGreaterThan(250)
  await expect.poll(() => left(page, PAGE)).toBeGreaterThan(250)
  await expect.poll(() => pref(page, 'device')).toEqual({ sidebarPinned: true })
  expect(await localStorageKeys(page)).toEqual([])
  await page.reload()
  await expect(page.getByText('Welcome')).toBeVisible()
  expect(await width(page, RAIL)).toBeGreaterThan(250)
  await page.keyboard.press('ControlOrMeta+b')
  await expect.poll(() => width(page, RAIL)).toBeLessThan(80)
})

test('assistant panel beside the page; a drawer on phones', async ({ page }) => {
  await signInAsOwner(page)
  await page.mouse.move(900, 450)
  const before = await width(page, PAGE)
  await page.locator('button[aria-controls=assistant-panel]').click()
  await expect.poll(() => width(page, '#assistant-panel')).toBeGreaterThanOrEqual(380)
  expect(await width(page, PAGE)).toBeLessThan(before - 350)
  await page.locator('#assistant-panel').getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => width(page, '#assistant-panel')).toBe(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator(RAIL)).toBeHidden()
  await page.locator('[data-slot=sidebar-trigger]').click()
  await expect(page.locator('[data-mobile=true]')).toBeVisible()
})

test('what is remembered: last tenant per person, wiped on sign-out; tabs stay in step', async ({ page, context }) => {
  const id = runId()
  await signInAsOwner(page)
  const mainPath = new URL(page.url()).pathname

  // Open another tenant (made here, which also opens it): / returns to it.
  await page.mouse.move(30, 100)
  await openSwitcher(page)
  await page.getByRole('button', { name: 'Add tenant' }).click()
  await page.getByRole('dialog').getByLabel('Name').fill(`Zeta ${id}`)
  await page.getByRole('dialog').getByRole('button', { name: 'Create tenant' }).click()
  await expect(page).not.toHaveURL(new RegExp(`${mainPath}$`))
  const zetaPath = new URL(page.url()).pathname
  await page.mouse.move(900, 450)
  await expect.poll(async () => ((await pref(page, 'person')) as { lastTenant?: string } | null)?.lastTenant).toBe(zetaPath.split('/')[2])
  await page.goto('/')
  await expect(page).toHaveURL(new RegExp(`${zetaPath}$`))

  // Pin the rail: a device preference, which must survive the sign-out below.
  await page.locator('[data-slot=sidebar-trigger]').click()
  await expect.poll(() => pref(page, 'device')).toEqual({ sidebarPinned: true })

  // A second tab in the same browser: signing out in one signs out both.
  const tab2 = await context.newPage()
  await tab2.goto(zetaPath)
  await expect(tab2.getByText('Welcome')).toBeVisible()
  await page.bringToFront()
  await openUserMenu(page)
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/) // a chosen sign-out: no way back to the last page
  await expect(tab2).toHaveURL(/\/login/)

  expect(await pref(page, 'person')).toBeNull()
  expect(await pref(page, 'device')).toEqual({ sidebarPinned: true })
  const session = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('auth/')
        open.onsuccess = () => {
          const get = open.result.transaction('session').objectStore('session').get('current')
          get.onsuccess = () => resolve(get.result ?? null)
        }
      }),
  )
  expect(session).toBeNull()

  // Signing in again: / opens the first tenant; the previous choice is gone.
  await page.getByLabel('Email', { exact: true }).fill(OWNER.email)
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(new RegExp(`${mainPath}$`))
  await tab2.goto('/')
  await expect(tab2).toHaveURL(/\/t\//) // picks up the new session

  await page.reload()
  await expect(page.getByText('Welcome')).toBeVisible() // a reload stays signed in
  expect(await localStorageKeys(page)).toEqual([])
  await expectNoCookies(page)
})
