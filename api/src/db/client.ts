/**
 * Postgres pool + Drizzle client, tuned for serverless.
 *
 * Created at module scope so warm Lambda/Netlify invocations reuse the same
 * pool instead of reconnecting per request. `max: 1` is deliberate: each
 * function instance handles one request at a time, so a larger pool would just
 * hold idle connections open against Supabase's connection limit.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { config } from "../config.js";
import * as schema from "./schema.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  // Serverless: one connection per instance, released quickly.
  max: config.isProduction ? 1 : 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: config.isProduction,
  // Supabase terminates the TLS session at the pooler with its own cert chain.
  ssl: config.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

// A pool-level error (e.g. Supabase dropping an idle connection) is emitted on
// the pool, not a query. Without this listener Node treats it as unhandled and
// crashes the process.
pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;

/** Transaction handle type, for repository functions that participate in one. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Either the root client or an open transaction — repositories accept both. */
export type DbLike = Db | DbTx;

export async function closeDb(): Promise<void> {
  await pool.end();
}
