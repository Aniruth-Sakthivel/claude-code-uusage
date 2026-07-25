/**
 * Migration runner.
 *
 *   npm run db:migrate
 *
 * Applies every committed SQL migration in ./drizzle, then seeds the roles.
 * Idempotent: already-applied migrations are skipped via Drizzle's journal.
 *
 * Uses DIRECT_URL (the session-mode pooler, port 5432) rather than the runtime
 * transaction pool. Transaction mode may hand each statement a different
 * backend connection, which breaks multi-statement DDL and advisory locks.
 *
 * This is the piece the Python stack never had — its "production uses Alembic"
 * comment was aspirational, and its dev fallback returned early on Postgres, so
 * schema changes had no path to production at all.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { config } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../drizzle");

async function main() {
  const url = config.DIRECT_URL ?? config.DATABASE_URL;
  const usingDirect = Boolean(config.DIRECT_URL);

  console.log(`Applying migrations from ${migrationsFolder}`);
  console.log(`Connection: ${usingDirect ? "DIRECT_URL (session mode)" : "DATABASE_URL"}`);

  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });

  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder });
    console.log("Migrations applied.");
  } finally {
    await client.end();
  }

  // Roles are reference data rather than schema, so they are seeded here.
  const { seedRoles } = await import("../services/auth.js");
  await seedRoles();
  console.log("Roles seeded.");

  const { closeDb } = await import("./client.js");
  await closeDb();
}

main().catch(async (err) => {
  console.error("\nMigration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
