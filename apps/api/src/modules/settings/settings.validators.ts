import { z } from 'zod';

export const generalSettingsSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(100),
});

/** `null` (or an empty name) goes back to the built-in default. */
export const brandingSchema = z.object({
  product_name: z
    .string()
    .trim()
    .max(60, 'Use at most 60 characters')
    .transform((v) => v || null)
    .nullable()
    .optional(),
  accent_color: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^#[0-9a-f]{6}$/, 'Use a colour like #2563eb')
    .nullable()
    .optional(),
});

export const assetSlotSchema = z.object({ slot: z.enum(['logo', 'icon'], 'Not found') });

export const securitySchema = z.object({
  two_factor_policy: z.enum(['off', 'org_roles', 'everyone'], 'Choose who must use two-factor sign-in'),
});
