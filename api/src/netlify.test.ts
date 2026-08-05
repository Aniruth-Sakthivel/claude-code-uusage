/**
 * Regression tests for the Netlify adapter's response encoding.
 *
 * The bug these lock down: the adapter returns `res.rawPayload` while dropping
 * `content-encoding` (Netlify's edge sets its own). With @fastify/compress
 * registered globally, every response over its ~1KB threshold went out as raw
 * gzip bytes labelled `application/json`, so clients failed with "JSON.parse:
 * unexpected character at line 1 column 1". Responses under the threshold —
 * /health among them — stayed uncompressed and looked perfectly fine, which is
 * what made it hard to spot.
 */

import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

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

/** Comfortably over @fastify/compress's 1024-byte default threshold. */
const BIG = { blob: "x".repeat(4096), nested: { note: "over the compress threshold" } };

async function makeApp(compression: boolean): Promise<FastifyInstance> {
  const { buildApp } = await import("./index.js");
  app = await buildApp({ compression });
  app.get("/api/v1/_big", async () => BIG);
  await app.ready();
  return app;
}

describe("netlify adapter response encoding", () => {
  it("compresses large responses when compression is on (the hazard)", async () => {
    const app = await makeApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/_big",
      headers: { "accept-encoding": "gzip" },
    });

    // This is the state the adapter must never forward as-is: encoded bytes
    // whose only marker is a header Netlify strips.
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(() => JSON.parse(res.rawPayload.toString("utf8"))).toThrow();
  });

  it("leaves large responses parseable when compression is off", async () => {
    const app = await makeApp(false);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/_big",
      headers: { "accept-encoding": "gzip, deflate, br" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(res.rawPayload.toString("utf8"))).toMatchObject({ blob: BIG.blob });
  });

  it("small responses were never affected — which masked the bug", async () => {
    const app = await makeApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/live",
      headers: { "accept-encoding": "gzip" },
    });

    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(res.rawPayload.toString("utf8"))).toMatchObject({ status: "ok" });
  });
});

describe("decodeBody safety net", () => {
  /**
   * Mirrors the adapter's decode step. If compression is ever re-enabled, or a
   * route sets an encoding itself, the body must still reach the client
   * decoded rather than as unparseable bytes.
   */
  async function decodeViaAdapter(payload: Buffer, encoding?: string): Promise<string> {
    const { __decodeBodyForTest } = await import("./netlify.js");
    return __decodeBodyForTest(payload, encoding).toString("utf8");
  }

  it("gunzips a gzip-encoded body", async () => {
    const json = JSON.stringify(BIG);
    expect(await decodeViaAdapter(gzipSync(json), "gzip")).toBe(json);
  });

  it("passes an unencoded body through untouched", async () => {
    const json = JSON.stringify({ ok: true });
    expect(await decodeViaAdapter(Buffer.from(json), undefined)).toBe(json);
  });

  it("returns the original bytes when decoding fails", async () => {
    const garbage = Buffer.from("not actually gzip");
    expect(await decodeViaAdapter(garbage, "gzip")).toBe("not actually gzip");
  });

  it("ignores an encoding it does not understand", async () => {
    const json = JSON.stringify({ ok: true });
    expect(await decodeViaAdapter(Buffer.from(json), "identity")).toBe(json);
  });
});
