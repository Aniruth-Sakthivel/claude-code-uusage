import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";

import { requestOrigin } from "./request-origin.js";

const req = (headers: Record<string, string>, protocol = "http") =>
  ({ headers, protocol }) as unknown as FastifyRequest;

describe("requestOrigin", () => {
  it("uses the forwarded host and proto set by the edge", () => {
    expect(
      requestOrigin(
        req({ "x-forwarded-host": "meterhouse.netlify.app", "x-forwarded-proto": "https" }),
      ),
    ).toBe("https://meterhouse.netlify.app");
  });

  /**
   * The hole this closes: `Origin` is absent on plenty of legitimate requests,
   * and the caller then falls back to a configured URL that can be stale.
   */
  it("works when the browser sent no Origin header", () => {
    expect(
      requestOrigin(req({ host: "meterhouse.netlify.app", "x-forwarded-proto": "https" })),
    ).toBe("https://meterhouse.netlify.app");
  });

  it("prefers the forwarded host over Origin", () => {
    expect(
      requestOrigin(
        req({
          "x-forwarded-host": "meterhouse.netlify.app",
          "x-forwarded-proto": "https",
          origin: "https://stale.example.com",
        }),
      ),
    ).toBe("https://meterhouse.netlify.app");
  });

  it("takes the first entry when a request crossed several proxies", () => {
    expect(
      requestOrigin(
        req({
          "x-forwarded-host": "meterhouse.netlify.app, internal.proxy",
          "x-forwarded-proto": "https, http",
        }),
      ),
    ).toBe("https://meterhouse.netlify.app");
  });

  it("falls back to the request protocol when none is forwarded", () => {
    expect(requestOrigin(req({ host: "127.0.0.1:8000" }))).toBe("http://127.0.0.1:8000");
  });

  it("falls back to Origin when there is no host at all", () => {
    expect(requestOrigin(req({ origin: "https://meterhouse.netlify.app" }))).toBe(
      "https://meterhouse.netlify.app",
    );
  });

  it("returns an empty string when nothing identifies the origin", () => {
    expect(requestOrigin(req({}))).toBe("");
  });
});
