/**
 * The first hour of an install: setup, the getting-started checklist,
 * branding, email health, renaming the organization and inviting a team.
 * Runs first, on an empty database; everything after shares the install it
 * creates (see playwright.config.ts).
 */

import { writeFileSync } from 'node:fs'

import type { Page } from '@playwright/test'

import {
  API,
  OWNER,
  SETUP_TOKEN,
  clearMail,
  chooseRole,
  expect,
  mailTo,
  newDevice,
  sidebar,
  sql,
  test,
  tenantIdOf,
} from './support'

/** The mail server's sender, set in Settings → Email; every later email in the run comes from it. */
const SENDER = 'hello@acme.test'

test.describe.configure({ mode: 'serial' })

let page: Page
let tenantId: string

const cssVar = (name: string) =>
  page.evaluate(
    (n) => document.documentElement.style.getPropertyValue(n),
    name,
  )
const checklist = () =>
  page.getByRole('region', { name: 'Get started' })

test.beforeAll(async ({ browser }) => {
  page = await newDevice(browser)
})
test.afterAll(async () => {
  await page.context().close()
})

test('a new install wears the default brand; setup creates the owner', async () => {
  await page.goto(`/setup?token=${SETUP_TOKEN}`)
  await expect(page.getByLabel('Organization name')).toBeVisible()
  await expect(page.getByText('App').first()).toBeVisible()
  await expect(page).toHaveTitle('App')

  await page.getByLabel('Organization name').fill(OWNER.org)
  await page.getByLabel('Your name').fill(OWNER.name)
  await page.getByLabel('Email', { exact: true }).fill(OWNER.email)
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password)
  await page.getByLabel('Confirm password').fill(OWNER.password)
  await page.getByRole('button', { name: 'Create workspace' }).click()

  await expect(page.getByText('Welcome, Asha')).toBeVisible()
  tenantId = tenantIdOf(page)
  await expect(page).toHaveTitle('Dashboard · App')
})

test('the getting-started checklist lists what to do first', async () => {
  await expect(checklist()).toBeVisible()
  await expect(checklist()).toContainText('0 of 3 done')
  const steps = checklist().getByRole('listitem')
  await expect(steps).toHaveCount(4)
  await expect(steps.nth(3)).toContainText('(optional)')
  await expect(
    sidebar(page).locator('[data-sidebar=menu-button]', { hasText: 'Settings' }),
  ).toHaveCount(1)
})

test('branding: name and colour, previewed, then applied everywhere at once', async () => {
  await checklist().getByRole('link', { name: 'Open branding' }).click()
  await expect(page).toHaveURL(/\/org\/settings\?tab=branding/)

  await page.getByLabel('Product name').fill('Northwind')
  const colour = page.getByLabel('Accent colour')
  await colour.fill('#ffff00')
  await expect(page.getByText('hard to see on white')).toBeVisible()
  await colour.fill('#2563EB')
  await expect(page.getByText('hard to see on white')).toHaveCount(0)

  // The preview shows it; the app does not, until saved.
  await expect(page.getByText('Continue', { exact: true })).toHaveCSS(
    'background-color',
    'rgb(37, 99, 235)',
  )
  expect(await cssVar('--primary')).toBe('')

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Branding saved')).toBeVisible()
  expect(await cssVar('--primary')).toBe('#2563eb')
  expect(await cssVar('--primary-foreground')).toBe('#ffffff')
  await expect(page).toHaveTitle('Settings · Northwind')
  await expect(sidebar(page).locator('[data-sidebar=header]')).toContainText(
    'Northwind',
  )
})

test('branding: logo and icon uploads, checked by the server', async ({}, testInfo) => {
  // Real PNGs, drawn by the browser.
  const draw = (w: number, h: number, text: string) =>
    page.evaluate(
      ([w, h, text]) => {
        const c = document.createElement('canvas')
        c.width = w as number
        c.height = h as number
        const x = c.getContext('2d')!
        x.fillStyle = '#2563eb'
        x.fillRect(0, 0, c.width, c.height)
        x.fillStyle = '#fff'
        x.font = 'bold 24px sans-serif'
        x.fillText(text as string, 10, 29)
        return c.toDataURL('image/png').split(',')[1]!
      },
      [w, h, text] as const,
    )
  const logo = testInfo.outputPath('logo.png')
  const icon = testInfo.outputPath('icon.png')
  const fake = testInfo.outputPath('not-an-image.png')
  writeFileSync(logo, Buffer.from(await draw(200, 40, 'Northwind'), 'base64'))
  writeFileSync(icon, Buffer.from(await draw(64, 64, ''), 'base64'))
  writeFileSync(fake, 'hello')

  // Named .png, but not an image: the server reads the content and says no.
  await page.getByLabel('Upload logo').setInputFiles(fake)
  await expect(page.getByText('Use a PNG, JPEG, WebP or SVG image.')).toBeVisible()

  await page.getByLabel('Upload logo').setInputFiles(logo)
  await expect(page.getByAltText('Current logo')).toHaveJSProperty('naturalWidth', 200)
  const header = sidebar(page).locator('[data-sidebar=header]')
  await expect(header.getByAltText('Northwind')).toHaveCount(1)

  await page.getByLabel('Upload icon').setInputFiles(icon)
  await expect(page.getByAltText('Current icon')).toHaveJSProperty('naturalWidth', 64)
  await expect(page.locator('link[rel=icon]')).toHaveAttribute(
    'href',
    /\/api\/branding\/assets\//,
  )
})

test('email: a mail server set up here, checked first, used by the API and the worker', async () => {
  await page.getByRole('tab', { name: 'Email' }).click()
  await expect(page).toHaveURL(/tab=email/)
  await expect(page.getByText('development mail catcher (Mailpit at localhost:8025)')).toBeVisible()

  // The owner enters the mail server (here: Mailpit's SMTP port). A wrong port is refused, with the reason.
  await page.getByLabel('Server', { exact: true }).fill('localhost')
  await page.getByLabel('Port', { exact: true }).fill('1')
  await page.getByLabel('Send as', { exact: true }).fill(SENDER)
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText("Couldn't connect to localhost:1")).toBeVisible()
  await page.getByLabel('Port', { exact: true }).fill('1025')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('Connected to localhost and signed in.')).toBeVisible()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Mail server saved')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible()

  // A test email, from the API process: the new sender, the brand's name.
  await clearMail(OWNER.email)
  await page.getByRole('button', { name: 'Send test email to me' }).click()
  await expect(page.getByText(`Sent to ${OWNER.email}`)).toBeVisible()
  await expect(page.getByText('Last successful test:')).toBeVisible()
  const mail = await mailTo(OWNER.email, 'Test email from Northwind')
  expect(mail.From).toEqual({ Name: 'Northwind', Address: SENDER })
  expect(mail.HTML).toContain('/api/branding/assets/')
  expect(mail.HTML).toContain('#2563eb')

  // An email the worker sends (another process): it picks the saved server up too.
  await fetch(`${API}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.200.0.1' },
    body: JSON.stringify({ email: OWNER.email }),
  })
  expect((await mailTo(OWNER.email, 'Reset your password')).From.Address).toBe(SENDER)
})

test('general: renaming the organization leaves the Main tenant alone', async () => {
  await page.getByRole('tab', { name: 'General' }).click()
  const name = page.getByLabel('Organization name')
  await expect(name).toHaveValue(OWNER.org)
  await name.fill('Acme Group')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Organization renamed')).toBeVisible()
  expect(sql<{ name: string }>('select name from organization')[0]!.name).toBe('Acme Group')
  expect(sql<{ name: string }>('select name from tenants where is_main')[0]!.name).toBe(OWNER.org)
})

test('bulk invite: a pasted list, then per-address results', async () => {
  await page.goto(`/t/${tenantId}`)
  await expect(checklist()).toContainText('2 of 3 done')
  await checklist().getByRole('link', { name: 'Invite people' }).click()
  await expect(page).toHaveURL(/\/people$/)

  await page.getByRole('button', { name: 'Invite person' }).click()
  const emails = page.getByLabel('Emails')
  await emails.fill('Ada Lovelace <ada@x.test>, ben@x.test\nBEN@x.test; bad@')
  await expect(page.getByText('2 addresses')).toBeVisible()
  await chooseRole(page, 'Viewer')
  await page.getByRole('button', { name: 'Send 2 invitations' }).click()
  await expect(page.getByText('2 invitations sent')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('cell', { name: 'ada@x.test' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'ben@x.test' })).toBeVisible()

  await page.getByRole('button', { name: 'Invite person' }).click()
  await page.getByLabel('Emails').fill(`cy@x.test\n${OWNER.email}`)
  await chooseRole(page, 'Viewer')
  await page.getByRole('button', { name: 'Send 2 invitations' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('1 of 2 invitations sent')
  await expect(dialog).toContainText(
    'Already has access to every tenant through their organization role.',
  )
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('cell', { name: 'cy@x.test' })).toBeVisible()
})

test('the checklist goes away once the required steps are done', async () => {
  await page.goto(`/t/${tenantId}`)
  await expect(page.getByText('Welcome, Asha')).toBeVisible()
  await expect(checklist()).toHaveCount(0)
})

test('failing email: a warning bar, the problem listed, cleared by a working test', async () => {
  // Let the worker finish with the email first, then rewrite it as given up.
  await expect
    .poll(() => sql(`select 1 from outbox where recipient = 'cy@x.test' and sent_at is not null`).length)
    .toBe(1)
  sql(
    `update outbox set sent_at = null, failed_at = now(), attempts = 8,
       last_error = 'Invalid login: 535 Authentication failed', payload = null
     where recipient = 'cy@x.test'`,
  )

  await page.goto(`/t/${tenantId}/people`)
  const bar = page.getByRole('status').filter({ hasText: "Email isn't working." })
  await expect(bar).toContainText('1 email could not be sent')
  await bar.getByRole('link', { name: 'See email settings' }).click()
  await expect(page).toHaveURL(/tab=email/)
  await expect(page.getByRole('cell', { name: /535 Authentication failed/ })).toBeVisible()
  await expect(page.getByText('Some emails are not going out')).toBeVisible()

  await page.getByRole('button', { name: 'Send test email to me' }).click()
  await expect(page.getByText(`Sent to ${OWNER.email}`)).toBeVisible()
  await page.goto(`/t/${tenantId}`)
  await expect(page.getByText('Welcome, Asha')).toBeVisible()
  await expect(page.getByText("Email isn't working.")).toHaveCount(0)
})

test('the audit log tells the settings story in sentences', async () => {
  await page.goto(`/t/${tenantId}/org/audit?category=settings`)
  const main = page.getByRole('main')
  await expect(main).toContainText('sent a test email')
  await expect(main).toContainText(`set the mail server to localhost:1025, sending as ${SENDER}`)
  await expect(main).toContainText(
    'set the product name to Northwind, set the accent colour to #2563eb',
  )
  await expect(main).toContainText('added the logo')
  await expect(main).toContainText('added the icon')
  await expect(main).toContainText('renamed the organization from Acme to Acme Group')
})

test('phone width: settings never scroll sideways', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const tab of ['general', 'branding', 'email']) {
    await page.goto(`/t/${tenantId}/org/settings?tab=${tab}`)
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow, tab).toBeLessThanOrEqual(0)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
})

test('signed out, the sign-in page wears the brand', async ({ page: fresh }) => {
  await fresh.goto('/login')
  await expect(fresh.getByAltText('Northwind')).toHaveJSProperty('naturalWidth', 200)
  await expect(fresh).toHaveTitle('Northwind')
  await expect(fresh.getByRole('button', { name: 'Sign in' })).toHaveCSS(
    'background-color',
    'rgb(37, 99, 235)',
  )
})
