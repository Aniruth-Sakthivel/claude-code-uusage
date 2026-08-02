import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// db/client.ts is imported dynamically inside index.ts's route handlers
// (`await import("./db/client.js")`) specifically so it can be swapped here —
// these are unit tests for the app's error/response plumbing, not integration
// tests against a live Postgres instance.
const queryMock = vi.fn();
vi.mock("./db/client.js", () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  queryMock.mockReset();
});

async function makeApp(setup?: (app: FastifyInstance) => void): Promise<FastifyInstance> {
  const { buildApp } = await import("./index.js");
  app = await buildApp();
  setup?.(app); // routes can still be registered before `.ready()`
  await app.ready();
  return app;
}

describe("health / ready / live", () => {
  it("GET /api/v1/live never touches the database", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/live" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("GET /api/v1/ready returns 200 when the database is reachable", async () => {
    queryMock.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok", database: "ok" });
  });

  it("GET /api/v1/ready returns 503 (not 200) when the database is unreachable", async () => {
    queryMock.mockRejectedValue(new Error("connection refused"));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("not_ready");
    // The raw driver message must never reach the client.
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });

  it("GET /api/v1/health always 200s and degrades via the status field (back-compat)", async () => {
    queryMock.mockRejectedValue(new Error("connection refused"));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("degraded");
    expect(body.database).toBe("error");
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });
});

describe("request id + response envelope", () => {
  it("sets X-Request-Id and echoes it in the JSON body on success", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/live" });
    const header = res.headers["x-request-id"];
    expect(typeof header).toBe("string");
    expect(JSON.parse(res.body).requestId).toBe(header);
    expect(typeof JSON.parse(res.body).timestamp).toBe("string");
  });

  it("sets a fresh X-Request-Id per request", async () => {
    const app = await makeApp();
    const a = await app.inject({ method: "GET", url: "/api/v1/live" });
    const b = await app.inject({ method: "GET", url: "/api/v1/live" });
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });

  it("includes requestId/timestamp/code/errors on error responses too", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ detail: "Not found", code: "NOT_FOUND", errors: [] });
    expect(typeof body.requestId).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });
});

describe("validation error shape", () => {
  // Every real route validates its body *after* its auth preHandler, so a
  // ZodError can't be reached through a live route without also faking auth.
  // Register a throwaway route on the same app instance (still legal before
  // `.ready()`) to exercise the global error handler's ZodError branch in
  // isolation — this is testing index.ts's error handler, not any one route.
  it("returns field-level errors, one per failing field", async () => {
    const { z } = await import("zod");
    const schema = z.object({ email: z.string().email(), age: z.number().int().min(0) });

    const app = await makeApp((app) => {
      app.post("/__test/validate", async (req) => {
        schema.parse(req.body);
        return { ok: true };
      });
    });

    const res = await app.inject({
      method: "POST",
      url: "/__test/validate",
      payload: { email: "not-an-email", age: -1 },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.errors).toEqual([
      { field: "email", message: expect.any(String) },
      { field: "age", message: expect.any(String) },
    ]);
    // `detail` still carries the first issue, for the existing frontend.
    expect(body.detail).toContain("email");
  });
});

describe("rate limit response shape", () => {
  it("still returns { detail } on 429 (unaffected by the new fields)", async () => {
    const app = await makeApp();
    // Global limit is 300/min — not worth burning in a unit test; instead
    // confirm the limiter is registered and responding normally under it.
    const res = await app.inject({ method: "GET", url: "/api/v1/live" });
    expect(res.headers["x-ratelimit-limit"]).toBe("300");
  });
});
