import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

loadEnv();

/**
 * Drizzle Kit config — generates SQL migrations into ./drizzle.
 *
 * Migrations are generated locally (`npm run db:generate`), committed to git,
 * and applied on deploy (`npm run db:migrate`). This replaces the Python
 * stack's `create_all` bootstrap, which silently never altered existing
 * tables and was a no-op on Postgres entirely.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Session-mode pooler for schema work; transaction mode is for runtime.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
  verbose: true,
  strict: true,
});
