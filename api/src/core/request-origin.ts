import type { FastifyRequest } from "fastify";

/**
 * Public origin a request arrived on, for building absolute links back.
 *
 * Prefers the edge's `x-forwarded-*` headers over the browser's `Origin`
 * header. `Origin` is absent on plenty of legitimate requests — a same-origin
 * GET, a server-to-server call, curl — and when it is missing the caller falls
 * back to the configured `PUBLIC_URL`, which is exactly the value that goes
 * stale after a rename. The forwarded host is set by the platform on every
 * request, so it does not have that hole.
 */
export function requestOrigin(req: FastifyRequest): string {
  const forwardedHost = req.headers["x-forwarded-host"] as string | undefined;
  const forwardedProto = req.headers["x-forwarded-proto"] as string | undefined;
  const host = forwardedHost ?? (req.headers.host as string | undefined);

  if (host) {
    // Comma-separated when a request crosses more than one proxy; the first
    // entry is the origin the client actually used.
    const firstHost = host.split(",")[0]!.trim();
    const proto = (forwardedProto ?? req.protocol).split(",")[0]!.trim();
    if (firstHost) return `${proto}://${firstHost}`;
  }

  const origin = req.headers.origin as string | undefined;
  return origin?.trim() ?? "";
}
