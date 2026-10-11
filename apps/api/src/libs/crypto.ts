/**
 * The few crypto operations the app needs, in one place, on WebCrypto.
 *
 *   encrypt / decrypt  secrets we must read back later (session refresh keys,
 *                      signing keys, provider API keys), AES-256-GCM
 *   hashToken          secrets we only ever compare (invite / setup / reset
 *                      tokens), HMAC-SHA256 with a server-side key
 *   randomToken        new unguessable tokens
 *   safeEqual          comparing secrets without leaking timing
 *
 * Every key is derived from APP_SECRET with HKDF, one per purpose, so the same
 * bytes are never used for two jobs and a new purpose never needs a new env
 * variable. The `/v1` in each label is the key version: rotating means adding
 * `/v2` and re-encrypting, not changing APP_SECRET.
 */

import { timingSafeEqual } from 'node:crypto';

import { env } from '#/libs/env';

const encoder = new TextEncoder();

const root = await crypto.subtle.importKey('raw', encoder.encode(env.APP_SECRET), 'HKDF', false, ['deriveKey']);

type DeriveParams = Parameters<typeof crypto.subtle.deriveKey>;

function derive(label: string, algorithm: DeriveParams[2], usages: DeriveParams[4]) {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('app-keys'), info: encoder.encode(label) },
    root,
    algorithm,
    false, // not extractable: the derived keys never leave this process
    usages,
  );
}

const encryptionKey = await derive('encryption/v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
const tokenHashKey = await derive('token-hash/v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);

/** First byte of every ciphertext, so the format can change without guessing. */
const FORMAT_V1 = 1;
const IV_BYTES = 12;

/**
 * Encrypts `plain` for storage. `context` names where the value lives
 * (`'iam.sessions.refresh_hmac_key'`): it is bound into the ciphertext, so a
 * value copied into another column fails to decrypt instead of being misused.
 *
 * Output: [format byte][12-byte IV][ciphertext + 16-byte tag].
 */
export async function encrypt(plain: Uint8Array | string, context: string): Promise<Uint8Array> {
  const data = typeof plain === 'string' ? encoder.encode(plain) : plain;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    encryptionKey,
    data,
  );
  const out = new Uint8Array(1 + IV_BYTES + sealed.byteLength);
  out[0] = FORMAT_V1;
  out.set(iv, 1);
  out.set(new Uint8Array(sealed), 1 + IV_BYTES);
  return out;
}

/** Reverses `encrypt`. Throws if the data was tampered with or `context` differs. */
export async function decrypt(blob: Uint8Array, context: string): Promise<Uint8Array> {
  if (blob[0] !== FORMAT_V1) throw new Error('Unknown ciphertext format');
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    encryptionKey,
    blob.subarray(1 + IV_BYTES),
  );
  return new Uint8Array(plain);
}

/**
 * Hash of a token we hand out and later look up (invite, setup, password
 * reset). Keyed, unlike a plain SHA-256: someone holding a copy of the database
 * still cannot check a guessed token offline without APP_SECRET.
 */
export async function hashToken(token: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', tokenHashKey, encoder.encode(token)));
}

/** `bytes` of randomness as base64url (32 bytes → 43 characters, 256 bits). */
export function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const input = typeof data === 'string' ? encoder.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/** Constant-time comparison: how long it takes reveals nothing about where they differ. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export const base64url = {
  encode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url'),
  decode: (text: string) => new Uint8Array(Buffer.from(text, 'base64url')),
};
