/**
 * Database handle type.
 *
 * Repositories accept a `Db`, which is satisfied by both the production
 * node-postgres client and the in-process PGlite instance the tests use — so
 * the poison-row suite exercises the same code path production does, against
 * real Postgres semantics, with no container required.
 */

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "./schema/tenancy.js";

export type Schema = typeof schema;

export type Db = PgDatabase<PgQueryResultHKT, Schema>;
