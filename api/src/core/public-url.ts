import { config } from "../config.js";

export function resolveInviteRedirectTo(
  requestOrigin?: string,
  publicUrl = config.PUBLIC_URL,
): string | undefined {
  const base = publicUrl?.trim() || requestOrigin?.trim();
  if (!base) return undefined;

  const normalized = base.replace(/\/$/, "");
  return normalized.endsWith("/login") ? normalized : `${normalized}/login`;
}
