import { createFileRoute, useRouter } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'

import { pageNeeds } from '#/components/app/page-guard'
import { ConfirmDialog } from '#/components/people/people-dialogs'
import {
  PageHeader,
  RowActions,
  Section,
  formatDate,
} from '#/components/people/people-parts'
import { ProjectDialog } from '#/components/projects/project-dialog'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import type { Project } from '#/lib/api/projects'
import { PROJECT_STATUS_LABELS, projectsApi } from '#/lib/api/projects'

/**
 * The example module's page: a list, with create, edit and delete for those
 * allowed. Buttons follow the permissions; the API checks them again.
 */
export const Route = createFileRoute('/_app/t/$tenantId/projects')({
  ...pageNeeds('projects.view', 'Projects'),
  loader: async ({ params, context }) => ({
    projects: await projectsApi.list(params.tenantId),
    can: {
      create: context.permissions.has('projects.create'),
      edit: context.permissions.has('projects.edit'),
      delete: context.permissions.has('projects.delete'),
    },
  }),
  component: ProjectsPage,
})

const STATUS_VARIANT = {
  active: 'default',
  on_hold: 'outline',
  done: 'secondary',
} as const

function ProjectsPage() {
  const { projects, can } = Route.useLoaderData()
  const { tenant } = Route.useRouteContext()
  const router = useRouter()
  const reload = () => void router.invalidate()

  // null: closed; 'new': creating; a project: editing it.
  const [editing, setEditing] = useState<Project | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)

  const actions = (p: Project) => [
    ...(can.edit ? [{ label: 'Edit', onSelect: () => setEditing(p) }] : []),
    ...(can.delete
      ? [{ label: 'Delete', onSelect: () => setDeleting(p), destructive: true }]
      : []),
  ]

  return (
    <div className="flex flex-col gap-8 p-4 md:p-6">
      <PageHeader
        title="Projects"
        description={`What ${tenant.name} is working on.`}
        action={
          can.create && (
            <Button onClick={() => setEditing('new')}>
              <PlusIcon aria-hidden="true" />
              New project
            </Button>
          )
        }
      />

      <Section
        title="All projects"
        description="Everyone in this tenant who can see projects sees this list."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Created</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-8 text-center text-muted-foreground"
                >
                  No projects yet.
                  {can.create && ' Create the first one.'}
                </TableCell>
              </TableRow>
            )}
            {projects.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="max-w-md whitespace-normal">
                  <div className="font-medium">{p.name}</div>
                  {p.description && (
                    <div className="line-clamp-2 text-xs text-muted-foreground">
                      {p.description}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[p.status]}>
                    {PROJECT_STATUS_LABELS[p.status]}
                  </Badge>
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {formatDate(p.created_at)}
                  {p.created_by && (
                    <div className="text-xs">by {p.created_by.name}</div>
                  )}
                </TableCell>
                <TableCell>
                  {actions(p).length > 0 && (
                    <RowActions
                      label={`Actions for ${p.name}`}
                      actions={actions(p)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <ProjectDialog
        tenantId={tenant.id}
        project={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        onDone={reload}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? ''}?`}
        description="It disappears from this list for everyone. The audit log keeps a record."
        confirmLabel="Delete"
        onOpenChange={(open) => !open && setDeleting(null)}
        run={() => projectsApi.remove(tenant.id, deleting?.id ?? '')}
        done={`${deleting?.name ?? 'Project'} deleted`}
        onDone={reload}
      />
    </div>
  )
}
