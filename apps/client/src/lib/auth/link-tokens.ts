/**
 * Single-use tokens from emailed or printed links (setup, password reset,
 * invitation, email change, new-sign-in alert). The route reads `?token=`
 * once, keeps it here, and removes it from the address bar straight away, so
 * it does not sit in history, get copied with the URL, or show on screen.
 *
 * Memory only, never storage: reload the page and the link must be opened
 * again — the safe default for a secret.
 */

export type LinkKind =
  'setup' | 'reset' | 'invite' | 'confirm-email' | 'sign-in-alert'

const tokens = new Map<LinkKind, string>()

export function keepLinkToken(kind: LinkKind, token: string) {
  tokens.set(kind, token)
}

export function linkToken(kind: LinkKind): string | null {
  return tokens.get(kind) ?? null
}

export function forgetLinkToken(kind: LinkKind) {
  tokens.delete(kind)
}
