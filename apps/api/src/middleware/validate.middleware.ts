/**
 * Request validation. Every route that reads input declares it with a Zod
 * schema, and the handler only ever sees parsed, typed values:
 *
 *   const createJob = z.object({ title: z.string().min(3) });
 *
 *   jobs.post('/', validate('json', createJob), (c) => {
 *     const { title } = c.req.valid('json'); // typed, already checked
 *   });
 *
 * Targets: 'json' (body), 'query', 'param', 'header', 'cookie', 'form'.
 *
 * On failure nothing below runs: an AppError('VALIDATION') is thrown and
 * `app.onError` answers 422 with `{ field: message }` in `error.details`.
 * Malformed JSON never reaches the schema — Hono rejects it first with a 400,
 * which `app.onError` maps to BAD_REQUEST.
 */

import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import { z } from 'zod';

import { validationError } from '#/libs/errors';

// Zod's default for a missing field is "Invalid input: expected string,
// received undefined" — accurate, but not something to show next to a form
// input. This only replaces that one case; a message a schema sets itself
// (`z.string().min(3, 'Title must be at least 3 characters')`) always wins.
z.config({
  customError: (issue) =>
    issue.code === 'invalid_type' && issue.input === undefined ? 'Required' : undefined,
});

export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throw validationError(result.error);
  });
}
