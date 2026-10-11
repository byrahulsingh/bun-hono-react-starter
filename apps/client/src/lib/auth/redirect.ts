/**
 * Where to go after signing in. Only paths inside this app are accepted:
 * `/login?redirect=https://evil.example` (or `//evil.example`, which browsers
 * treat as another host) must not send a freshly signed-in user elsewhere.
 */
export function safeRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/'
  if (value.startsWith('//') || value.includes('\\') || value.length > 500)
    return '/'
  if (value === '/login' || value.startsWith('/login?')) return '/'
  return value
}
