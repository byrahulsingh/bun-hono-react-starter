/**
 * Shared by every spec: the install's owner, a way to open more "devices",
 * reading emails from Mailpit, and calling the API directly to set up what a
 * test is not about. Black-box only: nothing here imports app code, the same
 * rule as between the client and the API.
 */

import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { test as base, expect } from '@playwright/test'
import type { Browser, Locator, Page } from '@playwright/test'

export { expect }

export const API = 'http://localhost:4100/api'
export const MAILPIT = 'http://localhost:8025/api/v1'
export const SETUP_TOKEN = 'e2e-setup-token-0123456789abcdef'

/** Created by onboarding.spec.ts, which every other spec runs after. */
export const OWNER = {
  email: 'owner@acme.test',
  password: 'correct horse battery',
  name: 'Asha Owner',
  /** Also the Main tenant's name: setup names it after the organization. */
  org: 'Acme',
}

export const PASSWORD = 'a long new password'

/** Per run and spec, so names and addresses never collide with earlier runs' emails. */
export const runId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

/**
 * A made-up client address per browser context, sent as X-Forwarded-For
 * (the e2e API trusts it). The API rate-limits sign-ins per address; one
 * address for a whole run would trip it.
 */
const randomIp = () =>
  `10.${1 + Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`

export const test = base.extend({
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'x-forwarded-for': randomIp() })
  },
})

/** Another browser, as if on another computer: its own storage, its own address. */
export async function newDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: 'http://localhost:3100',
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'x-forwarded-for': randomIp() },
  })
  return context.newPage()
}

// ─── Signing in ──────────────────────────────────────────────────

export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/t\//)
}

export const signInAsOwner = (page: Page) =>
  signIn(page, OWNER.email, OWNER.password)

/** The tenant id in the current URL (`/t/<id>/...`). */
export function tenantIdOf(page: Page): string {
  const id = new URL(page.url()).pathname.split('/')[2]
  if (!id) throw new Error(`not inside a tenant: ${page.url()}`)
  return id
}

// ─── Page pieces ─────────────────────────────────────────────────

export const sidebar = (page: Page) => page.locator('[data-sidebar=sidebar]')

/** The tenant switcher's box at the top of the sidebar; its title is the current tenant's name. */
export const switcher = (page: Page) =>
  page.locator('[data-sidebar=tenant-switcher]')

/** Opens the tenant list (also from the collapsed rail); returns each entry's text (letter, name, Main tag, your role there). */
export async function openSwitcher(page: Page): Promise<string[]> {
  await switcher(page).locator('[data-slot=tenant-badge]').click()
  await expect(page.getByRole('option').first()).toBeVisible()
  return page.getByRole('option').allTextContents()
}

/** The sidebar's items, once it has rendered. */
export async function navItems(page: Page): Promise<string[]> {
  const items = page.locator('[data-sidebar=menu-button]')
  await expect(items.filter({ hasText: 'Dashboard' })).toHaveCount(1)
  return items.allTextContents()
}

export const row = (page: Page, text: string): Locator =>
  page.getByRole('row').filter({ hasText: text })

/** Picks `option` in the role picker of the open dialog. */
export async function chooseRole(page: Page, option: string) {
  await page.getByRole('dialog').locator('#role_id').click()
  await page.getByRole('option', { name: option, exact: false }).first().click()
}

/** The ⋯ menu of a person's row, then one of its items. */
export async function rowAction(page: Page, name: string, item: string) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

export async function rowActions(page: Page, name: string): Promise<string[]> {
  const button = page.getByRole('button', { name: `Actions for ${name}`, exact: true })
  if ((await button.count()) === 0) return []
  await button.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const items = await menu.getByRole('menuitem').allTextContents()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0) // closed, so the next read is not this one
  return items.map((i) => i.trim())
}

// ─── Email (Mailpit) ─────────────────────────────────────────────

export interface Mail {
  Subject: string
  Text: string
  HTML: string
  From: { Name: string; Address: string }
}

/** The newest email to `to` (and with `subject` in its subject), waiting for it to arrive. */
export async function mailTo(to: string, subject = ''): Promise<Mail> {
  let found: Mail | undefined
  await expect
    .poll(
      async () => {
        const query = encodeURIComponent(`to:"${to}"`)
        const res = await fetch(`${MAILPIT}/search?query=${query}`)
        const list = (await res.json()) as {
          messages: { ID: string; Subject: string }[]
        }
        const hit = list.messages.find((m) => m.Subject.includes(subject))
        if (!hit) return false
        found = (await (
          await fetch(`${MAILPIT}/message/${hit.ID}`)
        ).json()) as Mail
        return true
      },
      { message: `email to ${to} (${subject || 'any subject'})`, timeout: 20_000 },
    )
    .toBe(true)
  return found!
}

/**
 * Deletes every email to `to`. For fixed addresses (the Dex users) that earlier
 * runs also wrote to, so mailTo() cannot pick up an old one.
 */
export async function clearMail(to: string): Promise<void> {
  const query = encodeURIComponent(`to:"${to}"`)
  await fetch(`${MAILPIT}/search?query=${query}`, { method: 'DELETE' })
}

// ─── Single sign-on (Dex, from compose.yaml) ─────────────────────

/** dev/dex/config.yaml: a real OpenID Connect provider on :5556. */
export const DEX = {
  issuer: 'http://localhost:5556/dex',
  clientId: 'app-local',
  clientSecret: 'app-local-secret',
  password: 'sso password 123',
}

/** On Dex's own sign-in page: email and password, then back to the app. */
export async function dexSignIn(page: Page, email: string) {
  await expect(page).toHaveURL(/localhost:5556\/dex\//)
  await page.locator('#login').fill(email)
  await page.locator('#password').fill(DEX.password)
  await page.locator('#submit-login').click()
}

/** The first link in an email's text containing `path`, as a path for page.goto. */
export function linkIn(mail: Mail, path: string): string {
  const url = mail.Text.match(new RegExp(`https?://\\S*${path}\\S*`))?.[0]
  if (!url) throw new Error(`no ${path} link in "${mail.Subject}"`)
  const { pathname, search } = new URL(url)
  return pathname + search
}

// ─── The API directly (setting the scene) ────────────────────────

/** The public half of a fresh device key, as the browser would send it. */
export async function devicePublicKey(): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  return crypto.subtle.exportKey('jwk', pair.publicKey)
}

/**
 * Every API sign-in in these tests comes from one "browser", so scripted
 * sign-ins do not count as new devices (and email about it) each time.
 */
const API_BROWSER_ID = 'e2e-api-client-browser-id'

/** A sign-in through the API, as a browser would; the raw response. */
export function apiLogin(email: string, password: string, ip = randomIp()) {
  return devicePublicKey().then((key) =>
    fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({
        email,
        password,
        device_public_key: key,
        browser_id: API_BROWSER_ID,
      }),
    }),
  )
}

/** A signed-in API client: a device key like the browser's, its own address. */
export async function apiAs(email: string, password: string) {
  const ip = randomIp()
  const res = await apiLogin(email, password, ip)
  const body = (await res.json()) as { data?: { access_token: string } }
  if (!body.data) throw new Error(`API sign-in failed for ${email}`)
  const token = body.data.access_token

  async function call<T = any>(method: string, path: string, data?: unknown) {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-forwarded-for': ip,
        ...(data !== undefined && { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    })
    const json = (await r.json()) as { data?: T; message: string }
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${json.message}`)
    return json.data as T
  }

  return {
    call,
    async roleId(scope: 'org' | `t/${string}`, name: string): Promise<string> {
      const roles = await call<{ id: string; name: string }[]>(
        'GET',
        scope === 'org' ? '/org/roles' : `/${scope}/roles`,
      )
      const role = roles.find((r) => r.name === name)
      if (!role) throw new Error(`no role ${name}`)
      return role.id
    },
    async createTenant(name: string): Promise<string> {
      return (await call<{ id: string }>('POST', '/tenants', { name })).id
    },
    async mainTenantId(): Promise<string> {
      const tenants = await call<{ id: string; is_main: boolean }[]>(
        'GET',
        '/tenants',
      )
      return tenants.find((t) => t.is_main)!.id
    },
  }
}

export const ownerApi = () => apiAs(OWNER.email, OWNER.password)

/**
 * Invites `email` and accepts it through the API: a person ready to sign in.
 * `tenantId` null: an organization role.
 */
export async function addPerson(
  inviter: Awaited<ReturnType<typeof apiAs>>,
  opts: { email: string; name: string; role: string; tenantId: string | null },
) {
  const scope = opts.tenantId ? (`t/${opts.tenantId}` as const) : 'org'
  const roleId = await inviter.roleId(scope, opts.role)
  await inviter.call(
    'POST',
    opts.tenantId ? `/t/${opts.tenantId}/invitations` : '/invitations',
    { email: opts.email, role_id: roleId },
  )
  const token = new URLSearchParams(
    linkIn(await mailTo(opts.email, 'invited you'), 'invite').split('?')[1],
  ).get('token')
  const res = await fetch(`${API}/invitations/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
    body: JSON.stringify({
      token,
      name: opts.name,
      password: PASSWORD,
      device_public_key: await devicePublicKey(),
    }),
  })
  if (!res.ok) throw new Error(`accepting ${opts.email} failed: ${res.status}`)
  // Accepting signs in; end that session, so the person starts with none.
  const { data } = (await res.json()) as { data: { access_token: string } }
  await fetch(`${API}/auth/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${data.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'local' }),
  })
}

// ─── The database (states the UI cannot reach) ───────────────────

const apiDir = fileURLToPath(new URL('../../api', import.meta.url))

/** One statement against the e2e database (never any other; the script refuses). */
export function sql<T = Record<string, unknown>>(statement: string): T[] {
  const out = execFileSync('bun', ['scripts/e2e-db.ts', 'sql', statement], {
    cwd: apiDir,
    encoding: 'utf8',
  })
  return JSON.parse(out.trim().split('\n').at(-1) ?? '[]') as T[]
}

/** IndexedDB contents of the current origin: database → store → keys. */
export async function indexedDbKeys(page: Page) {
  return page.evaluate(async () => {
    const out: Record<string, Record<string, string[]>> = {}
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(info.name!)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      out[info.name] = {}
      for (const store of [...db.objectStoreNames]) {
        out[info.name]![store] = await new Promise<string[]>((resolve) => {
          const req = db.transaction(store).objectStore(store).getAllKeys()
          req.onsuccess = () => resolve(req.result.map(String))
        })
      }
      db.close()
    }
    return out
  })
}

/** The app sets no cookies, ever. */
export async function expectNoCookies(page: Page) {
  expect(await page.context().cookies()).toEqual([])
}

// ─── Authenticator app (TOTP, RFC 6238) ──────────────────────────

/** What an authenticator app shows for `secret` (base32, spaces allowed), `offset` 30-second steps from now. */
export function totp(secret: string, offset = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of secret.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset))
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest()
  const at = mac[mac.length - 1]! & 0x0f
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
