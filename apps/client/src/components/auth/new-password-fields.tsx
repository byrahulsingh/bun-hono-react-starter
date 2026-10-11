import { TextField } from '#/components/auth/form-parts'

/** Password + confirmation, with the browser told it is a new password. */
export function NewPasswordFields({
  errors,
  label = 'Password',
}: {
  errors: Record<string, string>
  label?: string
}) {
  return (
    <>
      <TextField
        name="password"
        label={label}
        type="password"
        autoComplete="new-password"
        error={errors.password}
      />
      <TextField
        name="confirm_password"
        label={`Confirm ${label.toLowerCase()}`}
        type="password"
        autoComplete="new-password"
        error={errors.confirm_password}
      />
    </>
  )
}
