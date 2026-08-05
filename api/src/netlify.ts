/**
 * Netlify Functions entry point.
 *
 * The Fastify app is built once per container and reused across warm
 * invocations, so only a cold start pays the setup cost. Requests are handed to
 * Fastify via `app.inject`, which runs the full routing/validation pipeline
 * without opening a TCP listener.
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import type { FastifyInstance } from "fastify";

import { buildApp } from "./index.js";

/**
 * Undo any response encoding before handing the body to Netlify.
 *
 * `content-encoding` cannot be forwarded (the edge sets its own), so an
 * encoded body must be decoded here or the client gets raw gzip bytes labelled
 * `application/json`. Compression is disabled in the app for this reason, but
 * a route or plugin could still set an encoding — decode defensively rather
 * than corrupt the response. On any failure the original bytes are returned
 * unchanged, which is no worse than the alternative.
 */
function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  if (!body?.length || !encoding) return body;
  try {
    switch (encoding.trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return gunzipSync(body);
      case "br":
        return brotliDecompressSync(body);
      case "deflate":
        return inflateSync(body);
      default:
        return body;
    }
  } catch {
    return body;
  }
}

let appPromise: Promise<FastifyInstance> | null = null;

async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      // Compression OFF: `app.inject` hands back `res.rawPayload`, and the
      // `content-encoding` header cannot be forwarded (Netlify's edge sets its
      // own). Returning encoded bytes without that header is what broke every
      // response over @fastify/compress's 1KB threshold — the client received
      // gzip bytes labelled `application/json` and died on byte 1 with
      // "JSON.parse: unexpected character at line 1 column 1", while small
      // responses like /health stayed uncompressed and looked healthy.
      // The edge still gzips/brotlis on the way out, so nothing is lost.
      const app = await buildApp({ compression: false });
      await app.ready();
      return app;
    })().catch((err) => {
      // Don't memoize a failed cold start — otherwise one transient failure
      // (e.g. a DB hiccup) permanently breaks every request on this warm
      // container until Netlify recycles it. Let the next invocation retry.
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

/** Exposed for tests only — see netlify.test.ts. */
export const __decodeBodyForTest = decodeBody;

export default async function handler(request: Request): Promise<Response> {
  const app = await getApp();
  const url = new URL(request.url);

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const payload = hasBody ? await request.text() : undefined;

  const res = await app.inject({
    method: request.method as never,
    url: url.pathname + url.search,
    headers,
    ...(payload ? { payload } : {}),
  });

  const encoding = res.headers["content-encoding"];
  const body = decodeBody(
    res.rawPayload,
    Array.isArray(encoding) ? encoding[0] : (encoding as string | undefined),
  );

  const outHeaders = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    // Netlify manages these itself; forwarding them corrupts the response.
    if (key === "content-encoding" || key === "transfer-encoding") continue;
    // Would describe the encoded length once the body has been decoded above;
    // `Response` recomputes it from the bytes we actually send.
    if (key === "content-length") continue;
    outHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }

  return new Response(body, {
    status: res.statusCode,
    headers: outHeaders,
  });
}

/** Route every /api/* request here; the SPA fallback handles the rest. */
export const config = {
  path: "/api/*",
};
