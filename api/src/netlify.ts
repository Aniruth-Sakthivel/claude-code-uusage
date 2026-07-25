/**
 * Netlify Functions entry point.
 *
 * The Fastify app is built once per container and reused across warm
 * invocations, so only a cold start pays the setup cost. Requests are handed to
 * Fastify via `app.inject`, which runs the full routing/validation pipeline
 * without opening a TCP listener.
 */

import type { FastifyInstance } from "fastify";

import { buildApp } from "./index.js";

let appPromise: Promise<FastifyInstance> | null = null;

async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      const app = await buildApp();
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

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

  const outHeaders = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    // Netlify manages these itself; forwarding them corrupts the response.
    if (key === "content-encoding" || key === "transfer-encoding") continue;
    outHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }

  return new Response(res.rawPayload, {
    status: res.statusCode,
    headers: outHeaders,
  });
}

/** Route every /api/* request here; the SPA fallback handles the rest. */
export const config = {
  path: "/api/*",
};
