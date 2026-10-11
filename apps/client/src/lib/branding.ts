/**
 * The product's name, colour, logo and icon, applied to the whole app.
 *
 * Loaded once at start-up, alongside auth and preferences, so the first
 * screen already wears it. In production the server put it in the page
 * itself (window.__APP_CONFIG__), so there is nothing to wait for; in
 * development it is fetched, and never for longer than LOAD_TIMEOUT_MS.
 * Without it the app runs on the built-in look.
 */

import { create } from 'zustand'

import { apiUrl } from '#/lib/app-config'
import type { BrandAsset, Branding } from '#/lib/api/settings'
import { brandingApi } from '#/lib/api/settings'
import { textOn } from '#/lib/color'

const DEFAULT_BRANDING: Branding = {
  product_name: 'App',
  accent_color: null,
  logo: null,
  icon: null,
  version: 'default',
}

const LOAD_TIMEOUT_MS = 1500

export const useBranding = create<Branding>()(() => DEFAULT_BRANDING)

/** URL of an uploaded logo or icon (they never change; a new upload has a new id). */
export const brandAssetUrl = (asset: BrandAsset) =>
  apiUrl(`/branding/assets/${encodeURIComponent(asset.id)}`)

/** Theme tokens the accent colour replaces (styles.css holds the defaults). */
const ACCENT_TOKENS = [
  '--primary',
  '--ring',
  '--sidebar-primary',
  '--sidebar-ring',
]
const ON_ACCENT_TOKENS = [
  '--primary-foreground',
  '--sidebar-primary-foreground',
]

function apply(brand: Branding) {
  const root = document.documentElement.style
  for (const token of [...ACCENT_TOKENS, ...ON_ACCENT_TOKENS]) {
    root.removeProperty(token)
  }
  if (brand.accent_color) {
    const on = textOn(brand.accent_color)
    for (const token of ACCENT_TOKENS)
      root.setProperty(token, brand.accent_color)
    for (const token of ON_ACCENT_TOKENS) root.setProperty(token, on)
  }

  document.title = brand.product_name

  let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (brand.icon) {
    if (!icon) {
      icon = document.createElement('link')
      icon.rel = 'icon'
      document.head.append(icon)
    }
    icon.type = brand.icon.content_type
    icon.href = brandAssetUrl(brand.icon)
  } else {
    icon?.remove()
  }
}

/** Shows `brand` everywhere at once (after a save on the settings page, too). */
export function setBranding(brand: Branding) {
  useBranding.setState(brand, true)
  apply(brand)
}

let loaded: Promise<void> | null = null

/** Once, at start-up. Never throws. */
export function loadBranding(): Promise<void> {
  loaded ??= (async () => {
    const injected = window.__APP_CONFIG__?.branding
    if (injected) return setBranding(injected)
    try {
      setBranding(await brandingApi.get(LOAD_TIMEOUT_MS))
    } catch {
      apply(DEFAULT_BRANDING)
    }
  })()
  return loaded
}

/** Page title: "People · Product". */
export function pageTitle(page?: string) {
  const product = useBranding.getState().product_name
  return page ? `${page} · ${product}` : product
}
