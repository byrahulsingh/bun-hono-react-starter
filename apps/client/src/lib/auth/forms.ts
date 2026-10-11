/**
 * Client-side checks for the auth forms. They mirror the server's rules so
 * mistakes are caught before a round trip; the server checks again regardless.
 */

import { z } from 'zod'

const PASSWORD_MIN = 10
const PASSWORD_MAX = 128

export const email = z
  .string()
  .trim()
  .min(1, 'Required')
  .pipe(z.email('Enter a valid email address'))
export const name = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(100, 'Use at most 100 characters')
export const newPassword = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`)

/** A new password typed twice must match. */
const passwordsMatch: [
  (v: { password: string; confirm_password: string }) => boolean,
  { path: string[]; message: string },
] = [
  (v) => v.password === v.confirm_password,
  { path: ['confirm_password'], message: 'Passwords do not match' },
]

const newPasswordFields = {
  password: newPassword,
  confirm_password: z.string(),
}

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Required').max(PASSWORD_MAX),
})

export const forgotSchema = z.object({ email })

export const resetSchema = z.object(newPasswordFields).refine(...passwordsMatch)

export const setupSchema = z
  .object({ organization_name: name, name, email, ...newPasswordFields })
  .refine(...passwordsMatch)

export const acceptInviteSchema = z
  .object({ name, ...newPasswordFields })
  .refine(...passwordsMatch)

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1, 'Required').max(PASSWORD_MAX),
    ...newPasswordFields,
  })
  .refine(...passwordsMatch)

export const profileSchema = z.object({ name })
