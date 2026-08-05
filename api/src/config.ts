/**
 * Environment configuration, validated once at boot.
 *
 * Fails fast with a readable message rather than surfacing `undefined` deep
 * inside a request handler. Accepts both `METERHOUSE_`-prefixed names (what
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
    .default("https://github.com/Aniruth-Sakthivel/claude-code-uusage.git"),
  /**
   * Direct download URL for the standalone meterhouse.exe (built by
   * .github/workflows/release-agent.yml). Overrides the URL derived from
   * AGENT_REPO_URL — set this if the exe is hosted somewhere other than that
   * repo's GitHub Releases.
   */
  AGENT_EXE_URL: z.string().optional(),
  /**
   * Starter password given to every invited user. It is set on the Auth account
   * and repeated in the invite email next to the acceptance link, so someone can
   * sign in straight away with just their email address. Override per-deployment
   * if a different starter secret is wanted; users should change it after first
   * login (Supabase "forgot password" or an admin password reset).
   */
  INVITE_DEFAULT_PASSWORD: z.string().min(8).default("Dreams@99"),
  /** Comma-separated CORS origins. Empty in production (same-origin on Netlify). */
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://127.0.0.1:5173"),
  /**
   * Real-time WebSocket server — a separate persistent process (see
   * src/ws/server.ts), NOT part of the Netlify function. Netlify Functions are
   * stateless and cannot hold a socket open, so this always runs elsewhere
   * (Railway/Fly/a VPS/etc.) and is reached via its own public URL.
   */
  WS_PORT: z.coerce.number().int().positive().default(8787),
  /** wss://... URL agents/dashboards connect to. Unset = real-time push is off. */
  PUBLIC_WS_URL: z.string().optional(),
});

const parsed = schema.safeParse({
  DATABASE_URL: pick("DATABASE_URL", "METERHOUSE_DATABASE_URL"),
  DIRECT_URL: pick("DIRECT_URL"),
  SUPABASE_URL: pick("SUPABASE_URL", "METERHOUSE_SUPABASE_URL"),
  SUPABASE_ANON_KEY: pick("SUPABASE_ANON_KEY", "METERHOUSE_SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: pick(
    "SUPABASE_SERVICE_ROLE_KEY",
    "METERHOUSE_SUPABASE_SERVICE_ROLE_KEY",
  ),
  PORT: pick("PORT"),
  NODE_ENV: pick("NODE_ENV"),
  PUBLIC_URL: pick("PUBLIC_URL", "URL", "DEPLOY_PRIME_URL"), // Netlify sets URL
  AGENT_REPO_URL: pick("AGENT_REPO_URL"),
  AGENT_EXE_URL: pick("AGENT_EXE_URL"),
  INVITE_DEFAULT_PASSWORD: pick(
    "INVITE_DEFAULT_PASSWORD",
    "METERHOUSE_INVITE_DEFAULT_PASSWORD",
  ),
  CORS_ORIGINS: pick("CORS_ORIGINS", "METERHOUSE_CORS_ORIGINS"),
  WS_PORT: pick("WS_PORT"),
  PUBLIC_WS_URL: pick("PUBLIC_WS_URL"),
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

/**
 * GitHub's stable "latest release" asset URL never changes across releases, so
 * this needs no version bump when a new exe is published — see
 * .github/workflows/release-agent.yml, which is what publishes it there.
 */
function deriveExeUrl(repoUrl: string): string {
  const repoPage = repoUrl.replace(/\.git$/, "");
  return `${repoPage}/releases/latest/download/meterhouse.exe`;
}

export const config = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isTest: raw.NODE_ENV === "test",
  corsOrigins: raw.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  supabaseJwksUrl: `${raw.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`,
  agentExeUrl: raw.AGENT_EXE_URL || deriveExeUrl(raw.AGENT_REPO_URL),
} as const;

export type Config = typeof config;
