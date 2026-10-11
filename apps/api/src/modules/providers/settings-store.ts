/**
 * Settings for outside services made in the dashboard (`provider_settings`),
 * one row per service. The secret part is encrypted with a context per
 * service, so one service's ciphertext can never be read as another's.
 * Settings in the server's environment always win; each provider decides
 * that for itself.
 */

import { eq, sql } from 'drizzle-orm';

import type { Tx } from '#/db/db';
import { withApp } from '#/db/db';
import { providerSettings } from '#/db/schema';
import { decrypt, encrypt } from '#/libs/crypto';

const secretContext = (key: string) => `provider_settings.${key}.secret`;

export interface StoredSetting<C, S> {
  config: C;
  secret: S | null;
  updated_at: Date;
}

export async function readProviderSetting<C, S>(key: string): Promise<StoredSetting<C, S> | null> {
  const [row] = await withApp((tx) => tx.select().from(providerSettings).where(eq(providerSettings.key, key)));
  if (!row) return null;
  return {
    config: row.config as C,
    secret: row.secret ? (JSON.parse(new TextDecoder().decode(await decrypt(row.secret, secretContext(key)))) as S) : null,
    updated_at: row.updated_at,
  };
}

/** When the setting last changed (null: none saved). Cheap: how other processes notice a save. */
export async function providerSettingVersion(key: string): Promise<string | null> {
  const [row] = await withApp((tx) =>
    tx.select({ at: providerSettings.updated_at }).from(providerSettings).where(eq(providerSettings.key, key)),
  );
  return row ? row.at.toISOString() : null;
}

/** Saves a service's settings; `secret` null removes the stored secret. */
export async function writeProviderSetting(
  tx: Tx,
  key: string,
  input: { config: Record<string, unknown>; secret: Record<string, unknown> | null; updatedBy: string },
): Promise<void> {
  const secret = input.secret ? Buffer.from(await encrypt(JSON.stringify(input.secret), secretContext(key))) : null;
  const values = { config: input.config, secret, updated_by: input.updatedBy, updated_at: sql`clock_timestamp()` };
  await tx
    .insert(providerSettings)
    .values({ key, ...values })
    .onConflictDoUpdate({ target: providerSettings.key, set: values });
}

export async function deleteProviderSetting(tx: Tx, key: string): Promise<boolean> {
  const deleted = await tx.delete(providerSettings).where(eq(providerSettings.key, key)).returning({ key: providerSettings.key });
  return deleted.length > 0;
}
