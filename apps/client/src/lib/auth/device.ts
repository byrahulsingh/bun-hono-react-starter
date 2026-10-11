/**
 * The device key: an ECDSA P-256 key pair made by the browser at sign-in.
 *
 * The private half is created NON-EXTRACTABLE: page code can ask the browser
 * to sign with it, but no code (ours or an injected script) can ever read its
 * bytes. So a refresh token copied off this machine is useless: every refresh
 * needs a fresh proof signed by this key.
 */

import type { DevicePublicKey } from '#/lib/api/auth'

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const

export interface DeviceKey {
  privateKey: CryptoKey
  publicJwk: DevicePublicKey
}

/** WebCrypto signing exists only on secure origins (https, or localhost). */
export function cryptoAvailable(): boolean {
  // Browsers expose crypto.subtle exactly on secure origins.
  return window.isSecureContext
}

export async function generateDeviceKey(): Promise<DeviceKey> {
  // `false`: the private key can never be exported. (The public key of a
  // pair is always exportable, which is all the server needs.)
  const pair = await crypto.subtle.generateKey(ALGORITHM, false, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    privateKey: pair.privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! },
  }
}

const encoder = new TextEncoder()

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of array) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The proof sent with a refresh: a compact JWS (ES256) with the hash of the
 * exact refresh token being used and the time. WebCrypto's ECDSA signature is
 * already in the r||s form JWS expects, so no JWT library is needed.
 */
export async function signRefreshProof(
  privateKey: CryptoKey,
  refreshToken: string,
): Promise<string> {
  const th = base64url(
    await crypto.subtle.digest('SHA-256', encoder.encode(refreshToken)),
  )
  const header = base64url(
    encoder.encode(JSON.stringify({ alg: 'ES256', typ: 'refresh-proof' })),
  )
  const payload = base64url(
    encoder.encode(JSON.stringify({ th, iat: Math.floor(Date.now() / 1000) })),
  )
  const signingInput = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(signingInput),
  )
  return `${signingInput}.${base64url(signature)}`
}
