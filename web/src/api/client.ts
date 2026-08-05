/**
 * Thin fetch wrapper: injects the Supabase session JWT, parses JSON, throws
 * typed errors.
 *
 * Deliberately has no navigation side-effects. The previous version called
 * `window.location.href = "/login"` from inside the fetch layer *and* threw,
 * which made 401s impossible to handle locally. Session expiry is now handled
 * once, in AuthContext.
 */

import { supabase } from "../lib/supabase";

const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isAuthError() {
    return this.status === 401;
  }
}

/** Notified when the API reports an expired/invalid session. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  onUnauthorized = handler;
}

/**
 * True when the response body is actually JSON.
 *
 * Worth checking because the failure it guards against is silent and
 * misleading: when the API isn't reachable, a static server (`vite preview`,
 * or Netlify's SPA fallback if the function failed to deploy) answers
 * `/api/v1/...` with `index.html` and a **200**. Parsing that yields
 * "JSON.parse: unexpected character at line 1 column 1" — an error that says
 * nothing about the real problem.
 */
function isJson(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().includes("json");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers: Record<string, string> = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers as Record<string, string>),
  };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    // Provisioning legitimately 401s before an account exists; don't treat
    // that as a session expiry.
    if (!path.startsWith("/auth/")) onUnauthorized?.();
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204) return undefined as T;

  if (!isJson(res)) {
    throw new ApiError(
      res.status,
      `The API returned a non-JSON response for ${path}. The API server is ` +
        `probably not reachable — requests are falling through to the page ` +
        `itself. In dev, run the API on :8000; in production, check that the ` +
        `Netlify function deployed.`,
    );
  }

  return (await res.json()) as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }),
  patch: <T>(p: string, body: unknown) =>
    request<T>(p, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(p: string) => request<T>(p, { method: "DELETE" }),
};
