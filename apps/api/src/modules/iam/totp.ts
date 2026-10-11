/**
 * Time-based one-time codes (TOTP, RFC 6238), the kind every authenticator
 * app shows: HMAC-SHA1 over the current 30-second step, cut to 6 digits.
 * Short enough to own; checked against the RFC's test vectors (test/totp.test.ts).
 */

import { createHmac } from 'node:crypto';

export const TOTP = {
  stepSeconds: 30,
  digits: 6,
  /** Steps either side of now that still count: a clock a little off is fine. */
  window: 1,
  secretBytes: 20,
} as const;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding: how authenticator apps take a secret. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(TOTP.secretBytes));
}

export const stepAt = (unixSeconds: number) => Math.floor(unixSeconds / TOTP.stepSeconds);

/** The code for one step. `digits` only differs in tests (the RFC vectors use 8). */
export function totpCode(secret: Uint8Array, step: number, digits: number = TOTP.digits): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The step `code` belongs to, if it is valid now and newer than `lastUsedStep`
 * (so a code, once accepted, is never accepted again). Null otherwise.
 */
export function matchTotp(
  secret: Uint8Array,
  code: string,
  lastUsedStep: number | null,
  now: number = Date.now() / 1000,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  let matched: number | null = null;
  // Every candidate is computed (no early exit), so timing does not tell which matched.
  for (let step = current - TOTP.window; step <= current + TOTP.window; step++) {
    if (totpCode(secret, step) === code && (lastUsedStep === null || step > lastUsedStep)) matched ??= step;
  }
  return matched;
}
