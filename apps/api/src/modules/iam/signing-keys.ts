/**
 * ES256 keys that sign access tokens, stored in `iam.signing_keys` with the
 * private half encrypted. The first one is created on first use; rotation
 * retires the current key and creates a new one, while retired keys keep
 * verifying until every token they signed has expired.
 *
 * Kept in memory per process. A token with an unknown `kid` (signed by a key
 * another replica just created) triggers one reload, at most every 10 s, so
 * forged kids cannot be used to hammer the database.
 */

import { desc, gt, isNull, or } from 'drizzle-orm';
import type { CryptoKey, JWK } from 'jose';
import { exportJWK, generateKeyPair, importJWK } from 'jose';

import { withIam } from '#/db/db';
import { signingKeys } from '#/db/schema';
import { decrypt, encrypt, randomToken } from '#/libs/crypto';
import { logger } from '#/libs/logger';

import { AUTH } from './iam.config';

const ALG = 'ES256';
const PRIVATE_KEY_CONTEXT = 'iam.signing_keys.private_key';
/** A retired key keeps verifying for one token lifetime plus a margin. */
const RETIRED_GRACE_SECONDS = AUTH.accessTokenSeconds + 15 * 60;

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
}

let current: SigningKey | null = null;
const verifyKeys = new Map<string, CryptoKey>();
let lastReload = 0;

/** How often a process re-reads the current key, so a rotation reaches every replica. */
const RELOAD_EVERY_MS = 10 * 60 * 1000;

/**
 * `rotate`: retire the current key in the same transaction. The first key is
 * created without it, so two replicas starting at once cannot retire each
 * other's brand-new key: the loser's insert hits the unique index instead.
 */
async function createKey(rotate: boolean): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const kid = randomToken(12);
  const privateJwk = await exportJWK(privateKey);
  try {
    await withIam(async (tx) => {
      if (rotate) {
        await tx.update(signingKeys).set({ retired_at: new Date() }).where(isNull(signingKeys.retired_at));
      }
      await tx.insert(signingKeys).values({
        kid,
        alg: ALG,
        public_jwk: await exportJWK(publicKey),
        private_key: Buffer.from(await encrypt(JSON.stringify(privateJwk), PRIVATE_KEY_CONTEXT)),
      });
    });
    logger.auth.info({ kid }, 'Signing key created');
  } catch (err) {
    // Another replica created one at the same moment (unique "one current
    // key" index): use theirs.
    logger.auth.debug({ err }, 'Signing key creation lost a race; reloading');
  }
}

async function load(): Promise<void> {
  lastReload = Date.now();
  const graceStart = new Date(Date.now() - RETIRED_GRACE_SECONDS * 1000);
  const rows = await withIam((tx) =>
    tx
      .select()
      .from(signingKeys)
      .where(or(isNull(signingKeys.retired_at), gt(signingKeys.retired_at, graceStart)))
      .orderBy(desc(signingKeys.activated_at)),
  );

  verifyKeys.clear();
  for (const row of rows) {
    verifyKeys.set(row.kid, (await importJWK(row.public_jwk, ALG)) as CryptoKey);
  }

  const active = rows.find((row) => row.retired_at === null);
  if (active) {
    const jwk = JSON.parse(new TextDecoder().decode(await decrypt(active.private_key, PRIVATE_KEY_CONTEXT))) as JWK;
    current = { kid: active.kid, privateKey: (await importJWK(jwk, ALG)) as CryptoKey };
  } else {
    current = null;
  }
}

/** The key to sign new tokens with. */
export async function currentSigningKey(): Promise<SigningKey> {
  if (current && Date.now() - lastReload < RELOAD_EVERY_MS) return current;
  await load();
  if (!current) {
    await createKey(false);
    await load();
  }
  if (!current) throw new Error('No signing key available');
  return current;
}

/** The public key for a token's `kid`, or null if it is unknown or no longer trusted. */
export async function verificationKey(kid: string | undefined): Promise<CryptoKey | null> {
  if (!kid) return null;
  const known = verifyKeys.get(kid);
  if (known) return known;
  if (Date.now() - lastReload > 10_000) await load();
  return verifyKeys.get(kid) ?? null;
}

/** Retire the current key and start signing with a new one. For scheduled or emergency rotation. */
export async function rotateSigningKey(): Promise<void> {
  await createKey(true);
  await load();
}

/** Tests only: forget what is cached in this process. */
export function resetSigningKeyCache() {
  current = null;
  verifyKeys.clear();
  lastReload = 0;
}

