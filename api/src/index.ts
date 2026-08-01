/**
 * Fastify application factory.
 *
 * Exported (rather than started here) so the same app serves both the local dev
 * server and the Netlify function handler.
 */

import cors from "@fastify/cors";
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

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ detail: "Not found" }),
  );

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
