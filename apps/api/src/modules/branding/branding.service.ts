/**
 * White-label branding: the product name, accent colour, logo and icon that
 * staff see in the app and every email shows. The organization's row applies
 * everywhere; per-tenant rows come later.
 *
 * Read on every page load and every email, changed rarely: each process keeps
 * a copy for BRANDING_CACHE_MS. Another replica's change shows up within that.
 */

import { eq, inArray, isNull } from 'drizzle-orm';

import type { Tx } from '#/db/db';
import { withApp } from '#/db/db';
import { brandAssets, branding } from '#/db/schema';
import { env } from '#/libs/env';
import { AppError } from '#/libs/errors';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';

/** Used until someone names the product. Generic on purpose: no brand in code. */
export const DEFAULT_PRODUCT_NAME = 'App';

export const MAX_ASSET_BYTES = 512 * 1024;

const BRANDING_CACHE_MS = 30_000;

export type AssetSlot = 'logo' | 'icon';

export interface BrandAssetRef {
  id: string;
  content_type: string;
}

export interface Branding {
  product_name: string;
  /** `#rrggbb`, or null for the built-in look. */
  accent_color: string | null;
  logo: BrandAssetRef | null;
  icon: BrandAssetRef | null;
  /** True when the product name was set (not the default). */
  customized: boolean;
  /** Changes on every save, so anything rendered from it knows when to redo it. */
  version: string;
}

const DEFAULTS: Branding = {
  product_name: DEFAULT_PRODUCT_NAME,
  accent_color: null,
  logo: null,
  icon: null,
  customized: false,
  version: 'default',
};

let cached: { value: Branding; until: number } | null = null;

/** Drops this process's copy, after a save here (and in tests). */
export function forgetBranding() {
  cached = null;
}

async function readBranding(tx: Tx): Promise<Branding> {
  const [row] = await tx.select().from(branding).where(isNull(branding.tenant_id));
  if (!row) return DEFAULTS;

  const ids = [row.logo_id, row.icon_id].filter((v): v is string => v !== null);
  const assets = ids.length
    ? await tx
        .select({ id: brandAssets.id, content_type: brandAssets.content_type })
        .from(brandAssets)
        .where(inArray(brandAssets.id, ids))
    : [];
  const asset = (id: string | null) => assets.find((a) => a.id === id) ?? null;

  return {
    product_name: row.product_name ?? DEFAULT_PRODUCT_NAME,
    accent_color: row.accent_color,
    logo: asset(row.logo_id),
    icon: asset(row.icon_id),
    customized: row.product_name !== null || row.logo_id !== null || row.icon_id !== null || row.accent_color !== null,
    version: row.updated_at.toISOString(),
  };
}

/** The organization's branding: what every page and email uses. */
export async function getBranding(): Promise<Branding> {
  if (cached && cached.until > Date.now()) return cached.value;
  const value = await withApp(readBranding);
  cached = { value, until: Date.now() + BRANDING_CACHE_MS };
  return value;
}

/** Absolute URL of an asset, for emails (which cannot use a relative one). */
export function assetUrl(asset: BrandAssetRef): string {
  return `${env.APP_URL}/api/branding/assets/${asset.id}`;
}

// ─── Changing it (org.settings.manage; the routes check) ─────────

/** The organization's row, created on first change, locked until commit. */
async function lockOrgBranding(tx: Tx) {
  // Concurrent first saves: the unique index lets one insert through.
  await tx.insert(branding).values({}).onConflictDoNothing();
  const [row] = await tx.select().from(branding).where(isNull(branding.tenant_id)).for('update');
  return row!;
}

export async function updateBranding(
  actorUserId: string,
  input: { product_name?: string | null; accent_color?: string | null },
  meta: RequestMeta,
): Promise<Branding> {
  const result = await withApp(async (tx) => {
    const row = await lockOrgBranding(tx);
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    const set: { product_name?: string | null; accent_color?: string | null } = {};

    if (input.product_name !== undefined && input.product_name !== row.product_name) {
      changes.product_name = { from: row.product_name, to: input.product_name };
      set.product_name = input.product_name;
    }
    if (input.accent_color !== undefined && input.accent_color !== row.accent_color) {
      changes.accent_color = { from: row.accent_color, to: input.accent_color };
      set.accent_color = input.accent_color;
    }
    if (Object.keys(changes).length > 0) {
      await tx.update(branding).set({ ...set, updated_by: actorUserId }).where(eq(branding.id, row.id));
      await recordAudit(tx, { action: 'branding.updated', actorUserId, targetType: 'branding', targetId: row.id, changes }, meta);
    }
    return readBranding(tx);
  });
  forgetBranding();
  return result;
}

/**
 * What the file really is, from its first bytes. Only formats every browser
 * shows in an <img>; the upload's own Content-Type is not trusted.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';

  // SVG is text. A declaration, comments and a plain doctype may come first;
  // a doctype with its own entity definitions (`[ ... ]`) is refused.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 4096));
  } catch {
    return null;
  }
  const svg = /^﻿?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^[>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
  return svg.test(text) ? 'image/svg+xml' : null;
}

export async function setBrandAsset(actorUserId: string, slot: AssetSlot, bytes: Uint8Array, meta: RequestMeta): Promise<Branding> {
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'Use an image of 512 KB or less.');
  const contentType = sniffImage(bytes);
  if (!contentType) {
    throw new AppError('VALIDATION', 'Some fields are invalid.', { file: 'Use a PNG, JPEG, WebP or SVG image.' });
  }

  const result = await withApp(async (tx) => {
    const row = await lockOrgBranding(tx);
    const [asset] = await tx
      .insert(brandAssets)
      .values({ content_type: contentType, bytes: Buffer.from(bytes), size: bytes.byteLength, created_by: actorUserId })
      .returning({ id: brandAssets.id });
    const column = slot === 'logo' ? 'logo_id' : 'icon_id';
    const previous = row[column];
    await tx
      .update(branding)
      .set({ [column]: asset!.id, updated_by: actorUserId })
      .where(eq(branding.id, row.id));
    // Its URL may still be cached by browsers, which is fine: nothing links to it any more.
    if (previous) await tx.delete(brandAssets).where(eq(brandAssets.id, previous));
    await recordAudit(
      tx,
      { action: 'branding.updated', actorUserId, targetType: 'branding', targetId: row.id, changes: { [slot]: previous ? 'replaced' : 'added' } },
      meta,
    );
    return readBranding(tx);
  });
  forgetBranding();
  return result;
}

export async function removeBrandAsset(actorUserId: string, slot: AssetSlot, meta: RequestMeta): Promise<Branding> {
  const result = await withApp(async (tx) => {
    const row = await lockOrgBranding(tx);
    const column = slot === 'logo' ? 'logo_id' : 'icon_id';
    const previous = row[column];
    if (previous) {
      await tx
        .update(branding)
        .set({ [column]: null, updated_by: actorUserId })
        .where(eq(branding.id, row.id));
      await tx.delete(brandAssets).where(eq(brandAssets.id, previous));
      await recordAudit(
        tx,
        { action: 'branding.updated', actorUserId, targetType: 'branding', targetId: row.id, changes: { [slot]: 'removed' } },
        meta,
      );
    }
    return readBranding(tx);
  });
  forgetBranding();
  return result;
}

/** An asset's bytes, for the public URL. Null when there is no such asset. */
export async function readBrandAsset(id: string): Promise<{ content_type: string; bytes: Uint8Array } | null> {
  const [row] = await withApp((tx) =>
    tx.select({ content_type: brandAssets.content_type, bytes: brandAssets.bytes }).from(brandAssets).where(eq(brandAssets.id, id)),
  );
  return row ?? null;
}
