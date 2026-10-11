import { z } from 'zod';

import { PROJECT_STATUSES } from './projects.catalog';

const name = z.string().trim().min(1, 'Required').max(100, 'At most 100 characters');
const description = z.string().trim().max(2000, 'At most 2000 characters');
const status = z.enum(
  PROJECT_STATUSES.map((s) => s.key),
  'Choose a status',
);

export const createProjectSchema = z.object({ name, description: description.default('') });

/** Only the fields sent are changed. */
export const updateProjectSchema = z
  .object({ name, description, status })
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to change');

export const projectIdParamSchema = z.object({ id: z.uuid('Project not found.') });
