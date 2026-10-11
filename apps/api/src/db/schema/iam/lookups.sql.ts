import { lookupColumns } from '../column.helper';
import { iam } from './schema';

/** active · disabled */
export const userStatuses = iam.table('user_statuses', lookupColumns());

/** setup · recovery */
export const tokenTypes = iam.table('token_types', lookupColumns());
