import { describe, expect, test } from 'bun:test';

import { base32Decode, base32Encode, matchTotp, stepAt, totpCode } from '#/modules/iam/totp';

// RFC 6238 appendix B: the SHA-1 secret is the ASCII bytes "12345678901234567890".
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');

describe('totp', () => {
  test('matches the RFC 6238 test vectors (8 digits, SHA-1)', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [time, code] of vectors) expect(totpCode(RFC_SECRET, stepAt(time), 8)).toBe(code);
  });

  test('base32 round-trips, as authenticator apps expect', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(RFC_SECRET);
  });

  test('accepts one step either side of now, never a used step again', () => {
    const now = 1_800_000_000;
    const step = stepAt(now);
    const code = (s: number) => totpCode(RFC_SECRET, s);
    expect(matchTotp(RFC_SECRET, code(step), null, now)).toBe(step);
    expect(matchTotp(RFC_SECRET, code(step - 1), null, now)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, code(step + 1), null, now)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, code(step - 2), null, now)).toBeNull();
    expect(matchTotp(RFC_SECRET, code(step), step, now)).toBeNull(); // already used
    expect(matchTotp(RFC_SECRET, code(step + 1), step, now)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, '12345', null, now)).toBeNull();
    expect(matchTotp(RFC_SECRET, 'abcdef', null, now)).toBeNull();
  });
});
