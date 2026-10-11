import { createFileRoute, redirect } from '@tanstack/react-router'

import { ForgotPasswordForm } from '#/components/auth/forgot-password-form'
import { useAuthStore } from '#/lib/auth/store'

export const Route = createFileRoute('/_auth/forgot-password')({
  beforeLoad: () => {
    if (useAuthStore.getState().status === 'signed-in')
      throw redirect({ to: '/' })
  },
  component: ForgotPasswordForm,
})
