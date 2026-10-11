/**
 * Every table, one folder per Postgres schema. drizzle-kit reads this file
 * (drizzle.config.ts), and the rest of the code imports tables from here:
 *
 *   import { users, tenants } from '#/db/schema';
 *
 * Tables are the one shared model of one database, so they live together;
 * modules hold the behaviour. Each table still has one owning module that
 * writes it — for `iam` the database roles enforce that (db/access.ts).
 */
export * from './iam';
export * from './public';
