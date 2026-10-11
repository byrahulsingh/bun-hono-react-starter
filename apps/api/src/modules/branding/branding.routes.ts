import { Hono } from 'hono';
import { z } from 'zod';

import { apiResponse } from '#/libs/api-response';
import { AppError } from '#/libs/errors';
import { validate } from '#/middleware/validate.middleware';
import type { AppEnv } from '#/types/app.types';

import { getBranding, readBrandAsset } from './branding.service';

/**
 * Mounted at /api/branding. Public on purpose: the sign-in page and emails
 * show the branding before anyone has signed in. Holds nothing private.
 * Changing it is under /api/settings/branding.
 */
export const brandingRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const { customized: _, ...data } = await getBranding();
    return c.json(apiResponse({ success: true, message: 'ok', data }));
  })
  .get('/assets/:id', validate('param', z.object({ id: z.uuid('Not found') })), async (c) => {
    const asset = await readBrandAsset(c.req.valid('param').id);
    if (!asset) throw new AppError('NOT_FOUND', 'Image not found.');
    return c.body(asset.bytes as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': asset.content_type,
      // A new upload gets a new id, so this URL's content never changes.
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Emails embed it from other origins.
      'Cross-Origin-Resource-Policy': 'cross-origin',
      // An SVG opened directly runs no script and loads nothing.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  });
