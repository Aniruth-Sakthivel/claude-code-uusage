/**
 * The precedence here is deliberate and was learned the hard way: a stale
 * `PUBLIC_URL` (site renamed, leftover variable in the host's dashboard) kept
 * generating links to a host that returned 404, and nothing surfaced the
 * problem — the links simply never worked. The request origin is the host that
 * just served the request, so it is preferred whenever one is available.
 */

import { describe, expect, it } from "vitest";

import { resolveInviteRedirectTo } from "./public-url.js";

describe("resolveInviteRedirectTo", () => {
  it("prefers the request origin over a stale configured URL", () => {
    expect(
      resolveInviteRedirectTo("https://meterhouse.netlify.app", "https://old-name.netlify.app"),
    ).toBe("https://meterhouse.netlify.app/login");
  });

  it("falls back to the configured URL when there is no request origin", () => {
    expect(resolveInviteRedirectTo(undefined, "https://meterhouse.netlify.app")).toBe(
      "https://meterhouse.netlify.app/login",
    );
  });

  it("returns undefined when neither is available", () => {
    // `publicUrl` must be passed explicitly — omitting it (or passing
    // `undefined`) falls through to the default, which reads the real config.
    expect(resolveInviteRedirectTo(undefined, "")).toBeUndefined();
    expect(resolveInviteRedirectTo("  ", "  ")).toBeUndefined();
  });

  it("does not double up an existing /login suffix", () => {
    expect(resolveInviteRedirectTo("https://meterhouse.netlify.app/login")).toBe(
      "https://meterhouse.netlify.app/login",
    );
  });

  it("strips a trailing slash before appending", () => {
    expect(resolveInviteRedirectTo("https://meterhouse.netlify.app/")).toBe(
      "https://meterhouse.netlify.app/login",
    );
  });
});
