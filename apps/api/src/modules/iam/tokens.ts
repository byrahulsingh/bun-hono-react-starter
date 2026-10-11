/**
 * The three tokens:
 *
 *   access token   JWT signed by us (ES256), 10 minutes, kept in browser memory
 *   refresh token  opaque: session id + counter + HMAC, kept in IndexedDB
 *   device proof   JWT signed by the browser's non-extractable device key,
 *                  sent with every refresh
 */

import type { CryptoKey } from 'jose';
import { decodeProtectedHeader, importJWK, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import type { DevicePublicKey } from '#/db/schema';
import { base64url, safeEqual, sha256 } from '#/libs/crypto';
import { env } from '#/libs/env';

import { AUTH } from './iam.config';
import { currentSigningKey, verificationKey } from './signing-keys';

// ─── Access token ────────────────────────────────────────────────

const AUDIENCE = 'app';

export interface AccessClaims {
  /** User id. */
  sub: string;
  /** Session id. */
  sid: string;
}

/**
 * Deliberately small: no roles, no tenant. Permissions are checked per
 * request, so nothing in the token can go stale.
 */
export async function issueAccessToken(claims: AccessClaims): Promise<string> {
  const key = await currentSigningKey();
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'JWT' })
    .setIssuer(env.APP_URL)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${AUTH.accessTokenSeconds}s`)
    .sign(key.privateKey);
}

/** The claims if the token is genuine and unexpired; null otherwise. Never throws. */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { kid } = decodeProtectedHeader(token);
    const key = await verificationKey(kid);
    if (!key) return null;
    const { payload } = await jwtVerify(token, key, {
      issuer: env.APP_URL,
      audience: AUDIENCE,
      algorithms: ['ES256'],
      typ: 'JWT',
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { sub: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}

// ─── Refresh token ───────────────────────────────────────────────
//
//   [1 byte version][16 bytes session id][8 bytes counter][16 bytes HMAC]
//
// Nothing is stored per token. The HMAC uses a key unique to the session, so
// checking a token means loading its session row and recomputing it. Only the
// token carrying the session's current counter is valid (one step behind is
// tolerated, see iam.service.ts).

const REFRESH_VERSION = 1;
const MAC_BYTES = 16;
const REFRESH_BYTES = 1 + 16 + 8 + MAC_BYTES;

export interface RefreshTokenParts {
  sessionId: string;
  counter: number;
}

function uuidToBytes(uuid: string): Uint8Array {
  return Uint8Array.from(Buffer.from(uuid.replaceAll('-', ''), 'hex'));
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function body({ sessionId, counter }: RefreshTokenParts): Uint8Array {
  const out = new Uint8Array(1 + 16 + 8);
  out[0] = REFRESH_VERSION;
  out.set(uuidToBytes(sessionId), 1);
  new DataView(out.buffer).setBigUint64(17, BigInt(counter));
  return out;
}

async function mac(sessionKey: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', sessionKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data)).subarray(0, MAC_BYTES);
}

export async function encodeRefreshToken(parts: RefreshTokenParts, sessionKey: Uint8Array): Promise<string> {
  const data = body(parts);
  const out = new Uint8Array(REFRESH_BYTES);
  out.set(data, 0);
  out.set(await mac(sessionKey, data), data.length);
  return base64url.encode(out);
}

/** Reads the parts without checking the HMAC (that needs the session's key). Null if malformed. */
export function parseRefreshToken(token: string): (RefreshTokenParts & { mac: Uint8Array }) | null {
  if (token.length > 100) return null;
  const bytes = base64url.decode(token);
  if (bytes.length !== REFRESH_BYTES || bytes[0] !== REFRESH_VERSION) return null;
  return {
    sessionId: bytesToUuid(bytes.subarray(1, 17)),
    counter: Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(17)),
    mac: bytes.subarray(1 + 16 + 8),
  };
}

export async function refreshTokenMacValid(
  parts: RefreshTokenParts & { mac: Uint8Array },
  sessionKey: Uint8Array,
): Promise<boolean> {
  return safeEqual(parts.mac, await mac(sessionKey, body(parts)));
}

// ─── Device key and proof ────────────────────────────────────────

const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid key coordinate');

/**
 * The public half of the browser's device key, as sent at sign-in. Extra
 * fields browsers add (`ext`, `key_ops`) are dropped; a JWK carrying a private
 * part (`d`) is refused — the private key must never leave the device.
 */
export const devicePublicKeySchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: coordinate,
    y: coordinate,
    d: z.never('Send only the public key').optional(),
  })
  .transform(({ kty, crv, x, y }): DevicePublicKey => ({ kty, crv, x, y }));

/** True if the JWK is a real point on P-256 (not just well-formed text). */
export async function isUsableDeviceKey(jwk: DevicePublicKey): Promise<boolean> {
  try {
    await importJWK(jwk, 'ES256');
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a refresh request's proof: signed by the session's device key, made
 * in the last minute, and bound to this exact refresh token. Since a refresh
 * token works once, a captured proof cannot be replayed either.
 */
export async function verifyDeviceProof(
  proof: string,
  devicePublicKey: DevicePublicKey,
  refreshToken: string,
): Promise<boolean> {
  try {
    const key = (await importJWK(devicePublicKey, 'ES256')) as CryptoKey;
    const { payload } = await jwtVerify(proof, key, {
      algorithms: ['ES256'],
      typ: 'refresh-proof',
      maxTokenAge: `${AUTH.deviceProofMaxAgeSeconds}s`,
      clockTolerance: 5,
    });
    const expected = base64url.encode(await sha256(refreshToken));
    return typeof payload.th === 'string' && payload.th === expected;
  } catch {
    return false;
  }
}
