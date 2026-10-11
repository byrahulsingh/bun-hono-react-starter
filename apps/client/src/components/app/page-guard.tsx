import { ForbiddenError, NoPermission } from '#/components/app/page-states'
import { ApiError } from '#/lib/api/api'

/**
 * Route options for a page that needs one permission. A missing permission
 * shows "No access" inside the layout (sidebar stays); the API refuses the
 * data regardless, so this is about the experience, not the security.
 */
export function pageNeeds(
  permission: string,
  title: string,
  section?: 'organization',
) {
  return {
    staticData: { title, section },
    beforeLoad: ({ context }: { context: { permissions: Set<string> } }) => {
      if (!context.permissions.has(permission)) throw new ForbiddenError()
    },
    errorComponent: ({ error }: { error: unknown }) => {
      // Also when the API refuses the page's data: the role changed since
      // the permissions were loaded.
      if (
        error instanceof ForbiddenError ||
        (error instanceof ApiError && error.code === 'FORBIDDEN')
      )
        return <NoPermission />
      throw error
    },
  }
}
