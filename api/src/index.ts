/**
 * Fastify application factory.
 *
 * Exported (rather than started here) so the same app serves both the local dev
 * server and the Netlify function handler.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { config } from "./config.js";
import { isAppError } from "./core/errors.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { connectRoutes } from "./routes/connect.js";
import { accountRoutes } from "./routes/accounts.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { peopleRoutes } from "./routes/people.js";
import { settingsRoutes } from "./routes/settings.js";
import { usageRoutes } from "./routes/usage.js";

export const VERSION = "1.0.0";

/**
 * When running as a single Render service, the web build lives alongside
 * the API in the same checkout — this API process serves it directly
 * instead of relying on a separate static host. Netlify instead serves
 * web/dist through its own CDN, so this stays a no-op there.
 */
const webDistDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isTest ? false : { level: config.isProduction ? "warn" : "info" },
    trustProxy: true, // behind Netlify's edge
    bodyLimit: 8 * 1024 * 1024, // sync batches of up to 1000 events
  });

  // On Netlify the dashboard and API share an origin, so CORS is only needed
  // for local development against the Vite dev server.
  if (config.corsOrigins.length > 0) {
    await app.register(cors, { origin: config.corsOrigins, credentials: true });
  }

  /**
   * Uniform error shape: `{ detail }`, matching what the frontend already
   * parses. Unexpected errors are logged in full but never leak internals.
   */
  app.setErrorHandler((error, req, reply) => {
    if (isAppError(error)) {
      return reply.code(error.statusCode).send({ detail: error.message });
    }
    if (error instanceof ZodError) {
      const first = error.issues[0];
      const where = first?.path.join(".");
      return reply
        .code(400)
        .send({ detail: where ? `${where}: ${first?.message}` : "Invalid request" });
    }
    // Fastify's own errors (bad JSON, body too large, ...) carry a statusCode.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status < 500) {
      const message = error instanceof Error ? error.message : "Request failed";
      return reply.code(status).send({ detail: message });
    }
    req.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ detail: "Internal server error" });
  });

  const serveWebBuild = existsSync(webDistDir);
  if (serveWebBuild) {
    await app.register(fastifyStatic, { root: webDistDir });
  }

  app.setNotFoundHandler((req, reply) => {
    // SPA client-side routing: any unmatched non-API GET falls back to
    // index.html so React Router can resolve the path in the browser.
    if (serveWebBuild && req.method === "GET" && !req.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ detail: "Not found" });
  });

  /** Health check that actually touches the database. */
  app.get("/api/v1/health", async () => {
    const { pool } = await import("./db/client.js");
    let database = "ok";
    try {
      await pool.query("select 1");
    } catch (e) {
      database = e instanceof Error ? `error: ${e.message}` : "error";
    }
    return {
      status: database === "ok" ? "ok" : "degraded",
      service: "meterhouse",
      version: VERSION,
      database,
    };
  });

  await app.register(authRoutes);
  await app.register(dashboardRoutes);
  await app.register(usageRoutes);
  await app.register(connectRoutes);
  await app.register(adminRoutes);
  await app.register(accountRoutes);
  await app.register(settingsRoutes);
  await app.register(peopleRoutes);

  return app;
}
