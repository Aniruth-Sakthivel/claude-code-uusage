/**
 * Fastify application factory.
 *
 * Exported (rather than started here) so the same app serves both the local dev
 * server and the Netlify function handler.
 */

import { randomUUID } from "node:crypto";

import compress from "@fastify/compress";
import cors from "@fastify/cors";
import etag from "@fastify/etag";
import rateLimit from "@fastify/rate-limit";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { config } from "./config.js";
import { mapDatabaseError } from "./core/dbErrors.js";
import { isAppError, type FieldError } from "./core/errors.js";
import { requireCapability } from "./core/guards.js";
import { metrics } from "./core/metrics.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { connectRoutes } from "./routes/connect.js";
import { accountRoutes } from "./routes/accounts.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { automationRoutes } from "./routes/automation.js";
import { whiteboardRoutes } from "./routes/whiteboard.js";
import { chatRoutes } from "./routes/chat.js";
import { notificationRoutes } from "./routes/notifications.js";
import { peopleRoutes } from "./routes/people.js";
import { pmRoutes } from "./routes/pm.js";
import { settingsRoutes } from "./routes/settings.js";
import { usageRoutes } from "./routes/usage.js";

export const VERSION = "1.0.0";

export interface BuildOptions {
  /**
   * Compress responses inside Fastify.
   *
   * Must be OFF behind Netlify. The function adapter returns `res.rawPayload`
   * (the encoded bytes) while dropping `content-encoding`, because Netlify's
   * edge sets its own — so a gzipped body would arrive labelled
   * `application/json` and fail to parse at byte 1. The edge compresses on the
   * way out anyway, making in-function compression redundant there.
   */
  compression?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const { compression = true } = opts;
  const app = Fastify({
    logger: config.isTest ? false : { level: config.isProduction ? "warn" : "info" },
    // A real UUID (not Fastify's default sequential "req-1", "req-2", ...) so
    // it's actually useful as a correlation id once it leaves this process —
    // into logs, the X-Request-Id response header, and error bodies.
    genReqId: () => randomUUID(),
    // Replaced by the single structured "request completed" line in the
    // onResponse hook below — avoids two log lines per request that each
    // carry half the fields (Fastify's default omits userId/route). Passed
    // as a LogController instance (not the top-level `disableRequestLogging`
    // option) per Fastify 5's non-deprecated API.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true, // behind Netlify's edge
    bodyLimit: 8 * 1024 * 1024, // sync batches of up to 1000 events
    // Below Netlify's own 26s function timeout (netlify.toml) so a stuck
    // request fails with a clear 408 from us instead of the platform just
    // killing the invocation with no application-level response at all.
    requestTimeout: 25_000,
  });

  // Automatic gzip/brotli response compression — safe to apply globally,
  // operates purely on the outgoing body after the handler has already run.
  // Disabled under the Netlify adapter; see BuildOptions.compression.
  if (compression) {
    await app.register(compress, { global: true });
  }

  // Computes an ETag per response and handles If-None-Match with a 304,
  // saving the body transfer on unchanged data. Equally safe to apply
  // globally for the same reason as compression above.
  await app.register(etag);

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    // Default: never let a browser/proxy cache an API response, since most
    // of this API's data is per-user-scoped and changes on every sync. The
    // few genuinely cacheable routes (settings, registration-open) set their
    // own Cache-Control later in their handler, which overrides this.
    reply.header("Cache-Control", "no-store");
  });

  /**
   * One structured log line per request, in the exact shape ops tooling
   * expects to grep/filter on: requestId, userId, route, method, statusCode,
   * duration. `req.user`/`req.agentSystem` are set by the auth guards
   * (core/guards.ts) when present; both are `undefined` on public routes.
   */
  app.addHook("onResponse", async (req, reply) => {
    const durationMs = Math.round(reply.elapsedTime);
    metrics.recordRequest(reply.statusCode, durationMs);
    req.log.info(
      {
        requestId: req.id,
        userId: req.user?.id ?? null,
        systemId: req.agentSystem?.systemId ?? null,
        route: req.routeOptions?.url ?? req.url,
        method: req.method,
        statusCode: reply.statusCode,
        durationMs,
      },
      "request completed",
    );
  });

  /**
   * Adds `requestId` + `timestamp` to every JSON object response — success
   * and error alike — without touching the ~30 existing route handlers that
   * just `return someObject`. Runs before serialization, so this is a plain
   * object merge, not a JSON.parse/stringify round trip. Arrays, strings
   * (e.g. the plaintext installer script), Buffers, and `undefined` (204s)
   * are passed through untouched.
   */
  app.addHook("preSerialization", async (req, _reply, payload: unknown) => {
    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      !Buffer.isBuffer(payload)
    ) {
      return { ...payload, requestId: req.id, timestamp: new Date().toISOString() };
    }
    return payload;
  });

  // On Netlify the dashboard and API share an origin, so CORS is only needed
  // for local development against the Vite dev server.
  if (config.corsOrigins.length > 0) {
    await app.register(cors, { origin: config.corsOrigins, credentials: true });
  }

  // Global baseline against scraping/resource exhaustion; auth- and
  // enrollment-adjacent routes set their own tighter per-route limit below
  // (see routes/auth.ts, routes/connect.ts) since those are worth throttling
  // harder than ordinary dashboard reads. Keyed on the caller's IP — safe
  // under `trustProxy: true` since that's Netlify's edge-set X-Forwarded-For,
  // not an arbitrary client-supplied header.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({ detail: "Too many requests, slow down." }),
  });

  /**
   * Uniform error shape: `{ detail, code, errors }` — `detail` is the
   * original FastAPI-compat field the frontend already parses; `code` and
   * `errors` are additive (a JSON consumer that only reads `detail` is
   * unaffected). `requestId`/`timestamp` are added by the `preSerialization`
   * hook above, same as every other response. Never leaks a raw driver
   * message: unrecognized errors and database errors alike get a generic,
   * safe message, with the real one only going to `req.log.error`.
   */
  app.setErrorHandler((error, req, reply) => {
    if (isAppError(error)) {
      const errors: FieldError[] =
        "fieldErrors" in error ? (error as { fieldErrors: FieldError[] }).fieldErrors : [];
      return reply
        .code(error.statusCode)
        .send({ detail: error.message, code: error.code, errors });
    }
    if (error instanceof ZodError) {
      const errors: FieldError[] = error.issues.map((i) => ({
        field: i.path.join(".") || "(root)",
        message: i.message,
      }));
      const first = errors[0];
      return reply.code(400).send({
        detail: first ? `${first.field}: ${first.message}` : "Invalid request",
        code: "VALIDATION_ERROR",
        errors,
      });
    }
    // A raw Postgres error that escaped a repository/route without being
    // wrapped — map it to a safe message rather than falling through to the
    // generic 500 below (which would still be safe, but less specific).
    const dbError = mapDatabaseError(error);
    if (dbError) {
      req.log.error({ err: error, requestId: req.id }, "database error");
      return reply.code(dbError.statusCode).send({ detail: dbError.message, code: dbError.code, errors: [] });
    }
    // Fastify's own errors (bad JSON, body too large, ...) carry a statusCode.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status < 500) {
      const message = error instanceof Error ? error.message : "Request failed";
      return reply.code(status).send({ detail: message, code: "BAD_REQUEST", errors: [] });
    }
    req.log.error({ err: error, requestId: req.id }, "unhandled error");
    return reply
      .code(500)
      .send({ detail: "Internal server error", code: "INTERNAL_ERROR", errors: [] });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ detail: "Not found", code: "NOT_FOUND", errors: [] }),
  );

  /** Checks the database directly; never echoes the raw driver error to the
   * client (only to the server log) — see "Never expose raw database
   * messages" in core/dbErrors.ts's doc comment for why. */
  async function checkDatabase(req: { log: { error: (obj: unknown, msg: string) => void } }): Promise<boolean> {
    const { pool } = await import("./db/client.js");
    try {
      await pool.query("select 1");
      return true;
    } catch (e) {
      req.log.error({ err: e }, "health check: database unreachable");
      return false;
    }
  }

  /** Liveness: is the process itself up and able to handle requests at all?
   * No dependency checks — that's what /ready is for. A load balancer that
   * gets a non-200 here should restart the instance, not just stop routing
   * to it. */
  app.get("/api/v1/live", async () => ({ status: "ok" }));

  /** Readiness: can this instance actually serve traffic right now? Returns
   * 503 (not just a "degraded" field) when not, so orchestrators route
   * around it — the standard readiness-probe contract. */
  app.get("/api/v1/ready", async (req, reply) => {
    const databaseOk = await checkDatabase(req);
    if (!databaseOk) {
      reply.code(503);
      return { status: "not_ready", database: "error" };
    }
    return { status: "ok", database: "ok" };
  });

  /** Backward-compatible general health check (kept exactly at its existing
   * path/shape) — always 200s, degrades via the `status` field, for any
   * existing external monitor already polling it. */
  app.get("/api/v1/health", async (req) => {
    const databaseOk = await checkDatabase(req);
    return {
      status: databaseOk ? "ok" : "degraded",
      service: "meterhouse",
      version: VERSION,
      database: databaseOk ? "ok" : "error",
    };
  });

  /** Request/error/latency + cache-hit-ratio + memory for this warm instance.
   * Gated behind `view_audit` (the same capability the audit log uses) since
   * it's operational data, not something to expose publicly. */
  app.get(
    "/api/v1/metrics",
    { preHandler: requireCapability("view_audit") },
    async () => {
      const { cache } = await import("./core/cache.js");
      return { ...metrics.snapshot(), cache: cache.stats() };
    },
  );

  await app.register(authRoutes);
  await app.register(dashboardRoutes);
  await app.register(usageRoutes);
  await app.register(connectRoutes);
  await app.register(adminRoutes);
  await app.register(accountRoutes);
  await app.register(settingsRoutes);
  await app.register(peopleRoutes);
  await app.register(pmRoutes);
  await app.register(notificationRoutes);
  await app.register(chatRoutes);
  await app.register(automationRoutes);
  await app.register(whiteboardRoutes);

  return app;
}
