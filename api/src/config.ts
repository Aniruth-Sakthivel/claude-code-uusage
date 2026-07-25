/**
 * Environment configuration, validated once at boot.
 *
 * Fails fast with a readable message rather than surfacing `undefined` deep
 * inside a request handler. Accepts both `CLAUDEFLEET_`-prefixed names (what
 * the Python server used) and bare names (what Netlify UI encourages), so an
 * existing .env keeps working.
 */

import { z } from "zod";

// Load .env for local development. On Netlify the values come from the site's
// environment, so a missing file is not an error.
if (!process.env.NETLIFY) {
  const { config: loadEnv } = await import("dotenv");
  loadEnv();
}

function pick(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (Supabase Postgres URI)"),
  /**
   * Session-mode pooler, used only for migrations. Transaction mode rebinds a
   * backend connection per statement, which is wrong for multi-statement DDL.
   * Falls back to DATABASE_URL when unset.
   */
  DIRECT_URL: z.string().optional(),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a full https URL"),
  SUPABASE_ANON_KEY: z.string().min(1, "SUPABASE_ANON_KEY is required"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  PORT: z.coerce.number().int().positive().default(8000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Public origin of the dashboard — embedded in generated install scripts. */
  PUBLIC_URL: z.string().optional(),
  /** Git repo used as the agent install fallback when it is not on PyPI. */
  AGENT_REPO_URL: z
    .string()
    .default("https://github.com/YOUR-ORG/claude-code-uusage.git"),
  /** Comma-separated CORS origins. Empty in production (same-origin on Netlify). */
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://127.0.0.1:5173"),
});

const parsed = schema.safeParse({
  DATABASE_URL: pick("DATABASE_URL", "CLAUDEFLEET_DATABASE_URL"),
  DIRECT_URL: pick("DIRECT_URL"),
  SUPABASE_URL: pick("SUPABASE_URL", "CLAUDEFLEET_SUPABASE_URL"),
  SUPABASE_ANON_KEY: pick("SUPABASE_ANON_KEY", "CLAUDEFLEET_SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: pick(
    "SUPABASE_SERVICE_ROLE_KEY",
    "CLAUDEFLEET_SUPABASE_SERVICE_ROLE_KEY",
  ),
  PORT: pick("PORT"),
  NODE_ENV: pick("NODE_ENV"),
  PUBLIC_URL: pick("PUBLIC_URL", "URL", "DEPLOY_PRIME_URL"), // Netlify sets URL
  AGENT_REPO_URL: pick("AGENT_REPO_URL"),
  CORS_ORIGINS: pick("CORS_ORIGINS", "CLAUDEFLEET_CORS_ORIGINS"),
});

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
  throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
}

const raw = parsed.data;

/**
 * Serverless requires Supabase's transaction pooler (port 6543). On the direct
 * connection (5432) every function invocation opens a new backend connection
 * and exhausts Postgres under even modest traffic. We warn rather than throw
 * so local development against a direct URL still works.
 */
function checkPoolerPort(url: string): void {
  if (raw.NODE_ENV !== "production") return;
  if (!url.includes(":6543")) {
    console.warn(
      "[config] WARNING: DATABASE_URL does not use port 6543. In a serverless " +
        "deployment use the Supabase *transaction pooler* connection string, " +
        "otherwise connections will be exhausted.",
    );
  }
}
checkPoolerPort(raw.DATABASE_URL);

export const config = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isTest: raw.NODE_ENV === "test",
  corsOrigins: raw.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  supabaseJwksUrl: `${raw.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`,
} as const;

export type Config = typeof config;
