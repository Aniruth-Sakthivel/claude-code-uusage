/**
 * Supabase Auth admin operations (service-role key — never sent to the browser).
 *
 * Used only to provision and manage Auth users when an admin adds or edits an
 * account. Supabase Auth is the source of truth for credentials; this app never
 * stores or hashes passwords.
 *
 * Note: `@supabase/supabase-js` supports both the legacy JWT-style keys and the
 * newer opaque `sb_secret_…` / `sb_publishable_…` format. The Python client did
 * not, which is what broke user creation on the previous stack.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

import { config } from "../config.js";
import { badRequest } from "./errors.js";

// supabase-js unconditionally constructs a realtime client, which requires a
// global WebSocket (native only on Node 22+). Netlify Functions run Node 20,
// and this module never opens a realtime channel — it only calls
// auth.admin.* REST methods — so a polyfill is enough to satisfy the check.
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

let cached: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GoTrue intermittently returns a signing error ("unrecognized JWT kid") when
 * admin calls arrive in quick succession. It is transient, so retry briefly
 * rather than surfacing a confusing failure to the operator.
 */
function isTransientAuthError(message: string | undefined): boolean {
  if (!message) return false;
  return /unrecognized JWT kid|unable to parse or verify signature|rate limit/i.test(
    message,
  );
}

/** Create an Auth user with a known password (admin-set, email pre-confirmed). */
export async function createAuthUser(
  email: string,
  password: string,
  fullName = "",
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await getAdminClient().auth.admin.createUser({
      email,
      password,
      // Pre-confirmed: an admin set this password, so there is nothing to
      // verify by email — and it avoids depending on a configured mailer.
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (!error && data.user) return data.user.id;
    if (attempt === 3 || !isTransientAuthError(error?.message)) {
      throw badRequest(`Could not create auth user: ${error?.message ?? "unknown error"}`);
    }
    await sleep(attempt * 1000);
  }
  throw badRequest("Could not create auth user");
}

/**
 * Invite a user by email — they set their own password via the emailed link.
 * Preferred over `createAuthUser`, which requires sharing a password
 * out-of-band.
 */
export async function inviteAuthUser(
  email: string,
  fullName = "",
  redirectTo?: string,
): Promise<string> {
  const { data, error } = await getAdminClient().auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo,
  });
  if (error || !data.user) {
    throw badRequest(`Could not invite user: ${error?.message ?? "unknown error"}`);
  }
  return data.user.id;
}

/** Find an existing Auth user id by email, or null. */
export async function findAuthUserByEmail(email: string): Promise<string | null> {
  const target = email.toLowerCase();
  // The admin API paginates; scan until found or exhausted.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await getAdminClient().auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw badRequest(`Could not list auth users: ${error.message}`);
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 200) break; // last page
  }
  return null;
}

export async function updateAuthUserPassword(
  supabaseUserId: string,
  password: string,
): Promise<void> {
  const { error } = await getAdminClient().auth.admin.updateUserById(supabaseUserId, {
    password,
  });
  if (error) throw badRequest(`Could not update password: ${error.message}`);
}

export async function deleteAuthUser(supabaseUserId: string): Promise<void> {
  const { error } = await getAdminClient().auth.admin.deleteUser(supabaseUserId);
  // Already gone is not an error for our purposes.
  if (error && !/not found/i.test(error.message)) {
    throw badRequest(`Could not delete auth user: ${error.message}`);
  }
}
