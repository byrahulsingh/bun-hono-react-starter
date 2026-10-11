/**
 * What the single sign-on provider sent back, between reading it from the
 * address bar and using it, and the result of a test sign-in on its way to
 * the settings page. Memory only, like link tokens (link-tokens.ts): a code
 * must not sit in history or storage.
 */

import type { SsoTestResult } from '#/lib/api/settings'

export interface SsoAnswer {
  code?: string
  state?: string
  error?: string
  error_description?: string
}

let answer: SsoAnswer | null = null
let testResult: SsoTestResult | null = null

export function keepSsoAnswer(next: SsoAnswer) {
  answer = next
}

/** Read once. */
export function takeSsoAnswer(): SsoAnswer | null {
  const taken = answer
  answer = null
  return taken
}

export function keepSsoTestResult(result: SsoTestResult) {
  testResult = result
}

/** For the settings page the test returns to (which clears it once shown). */
export function peekSsoTestResult(): SsoTestResult | null {
  return testResult
}

export function clearSsoTestResult() {
  testResult = null
}
