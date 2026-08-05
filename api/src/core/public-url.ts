import { config } from "../config.js";

/**
 * Where an invited user should land after accepting.
 *
 * Prefers the request origin over the configured `PUBLIC_URL` for the same
 * reason as the enrollment base URL (see services/onboarding.ts): a stale
 * configured value sends invitees to a host that no longer serves the app,
 * with nothing to indicate why. The origin is the host that just served the
 * request, so it is known good.
 */
export function resolveInviteRedirectTo(
  requestOrigin?: string,
  publicUrl = config.PUBLIC_URL,
): string | undefined {
  const base = requestOrigin?.trim() || publicUrl?.trim();
  if (!base) return undefined;

  const normalized = base.replace(/\/$/, "");
  return normalized.endsWith("/login") ? normalized : `${normalized}/login`;
}
