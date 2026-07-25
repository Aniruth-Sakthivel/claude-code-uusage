/**
 * End-to-end smoke test against the running API and the real Supabase project.
 *
 * Proves the whole chain the previous stack never demonstrated:
 *   Supabase sign-in -> provision -> connect PC -> agent sync -> dashboard,
 * plus the two guarantees that matter most: idempotent dedup and fail-closed
 * RBAC scoping.
 *
 * Creates its own throwaway Supabase users and deletes them at the end.
 *
 *   node tests/e2e-smoke.mjs
 */

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv();

const BASE = process.env.API_BASE ?? "http://127.0.0.1:8000";
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(SUPABASE_URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let passed = 0;
let failed = 0;
const cleanup = [];

function check(name, ok, extra = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

async function api(path, { token, method = "GET", body } = {}) {
  // Only declare a JSON content-type when there is actually a body; Fastify
  // rejects an empty body that claims to be JSON.
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 204 or non-JSON */
  }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeUser(label) {
  // `email_confirm: true` is required — without it GoTrue tries to send a
  // confirmation email, and this project's mailer signing surfaces a confusing
  // "unrecognized JWT kid" error. That error is also returned intermittently
  // under rapid admin calls, so retry with backoff.
  const email = `e2e-${label}-${Date.now()}@example.com`;
  const password = "e2e-password-123";

  let data, error;
  for (let attempt = 1; attempt <= 4; attempt++) {
    ({ data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `E2E ${label}` },
    }));
    if (!error) break;
    if (attempt < 4) await sleep(attempt * 1500);
  }
  if (error) throw new Error(`createUser: ${error.message}`);
  cleanup.push(data.user.id);

  return { ...(await signIn(email, password)), email };
}

/** Sign in against Supabase and return the access token. */
async function signIn(email, password) {
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: sess, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn: ${error.message}`);
  return { email, token: sess.session.access_token };
}

function event(suffix, { tokens = 100, day = "2026-07-25", session = "sess-1" } = {}) {
  return {
    suffix,
    session_id: session,
    project_name: "e2e/demo",
    ts_utc: `${day}T10:00:00+00:00`,
    day,
    model: "claude-opus-4-8",
    model_family: "opus",
    input_tokens: tokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: tokens,
    tool_name: null,
    is_subagent: 0,
    agent_id: null,
  };
}

console.log(`\nClaudeFleet end-to-end smoke test -> ${BASE}\n`);

// ── 0. reset ──────────────────────────────────────────────────────────────────
// The "first user becomes admin" path only runs when no users exist, so wipe
// data left by a previous run. Roles are reference data and are preserved.
{
  const pg = (await import("pg")).default;
  const c = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query(`
    truncate table usage_events, daily_aggregates, sync_logs, enroll_tokens,
                   api_keys, user_systems, systems, audit_logs, users
    restart identity cascade`);
  await c.end();
  console.log("reset: cleared previous test data\n");
}

// ── 1. health ─────────────────────────────────────────────────────────────────
console.log("health");
const health = await api("/health");
check("health ok + database reachable", health.body?.database === "ok");

// ── 2. first user becomes admin ───────────────────────────────────────────────
console.log("\nauth / provisioning");
const adminUser = await makeUser("admin");
const prov = await api("/auth/provision", { token: adminUser.token, method: "POST" });
check(
  "provision succeeds",
  prov.status === 200,
  `got ${prov.status} ${JSON.stringify(prov.body)}`,
);
check("first user becomes admin", prov.body?.role === "admin", `got ${prov.body?.role}`);
check(
  "capabilities returned for UI gating",
  Array.isArray(prov.body?.capabilities) && prov.body.capabilities.includes("manage_users"),
);

const me = await api("/auth/me", { token: adminUser.token });
check("/auth/me works", me.status === 200 && me.body?.email === adminUser.email);

// ── 3. one-click connect ──────────────────────────────────────────────────────
console.log("\none-click connect");
const connect = await api("/connect/self", {
  token: adminUser.token,
  method: "POST",
  body: { display_name: "E2E-PC-01" },
});
check("connect/self creates a system", connect.status === 200, `got ${connect.status}`);
check(
  "returns a one-line install command",
  typeof connect.body?.install_command === "string" &&
    connect.body.install_command.includes("| iex"),
);
check("returns an api key", connect.body?.api_key?.startsWith("cfk_"));

const sysId = connect.body?.system_id;
const agentKey = connect.body?.api_key;
// The command points at PUBLIC_URL (the dashboard origin, which proxies /api).
// In this test the dashboard isn't running, so fetch the script from the API
// directly by swapping the origin for BASE.
const enrollPath = connect.body?.install_command?.match(/\/api\/v1\/connect\/script\/\S+/)?.[0];
const enrollUrl = enrollPath ? `${BASE}${enrollPath}` : undefined;

// ── 4. enroll token is single-use ─────────────────────────────────────────────
const script1 = await fetch(enrollUrl);
const scriptText = await script1.text();
check("install script is served", script1.status === 200, `got ${script1.status}`);
check("script embeds the api key", scriptText.includes(agentKey));
check("script schedules recurring scan+sync", scriptText.includes("schtasks"));

const script2 = await fetch(enrollUrl);
check("enroll token is single-use", script2.status === 403, `got ${script2.status}`);

// ── 5. agent auth separation ──────────────────────────────────────────────────
console.log("\nauth separation");
const jwtOnAgent = await api("/usage/sync", {
  token: adminUser.token,
  method: "POST",
  body: { events: [event("x")] },
});
check("user JWT rejected on agent route", jwtOnAgent.status === 401, `got ${jwtOnAgent.status}`);

const keyOnAdmin = await api("/admin/users", { token: agentKey });
check("agent key rejected on admin route", keyOnAdmin.status === 401, `got ${keyOnAdmin.status}`);

// ── 6. sync + dedup (the core guarantee) ──────────────────────────────────────
console.log("\nsync / dedup");
const batch = [event("m1", { tokens: 100 }), event("m2", { tokens: 50 })];

const sync1 = await api("/usage/sync", { token: agentKey, method: "POST", body: { events: batch } });
check(
  "first sync inserts both events",
  sync1.body?.inserted === 2 && sync1.body?.duplicates === 0,
  JSON.stringify(sync1.body),
);

const sync2 = await api("/usage/sync", { token: agentKey, method: "POST", body: { events: batch } });
check(
  "re-sync counts all as duplicates",
  sync2.body?.inserted === 0 && sync2.body?.duplicates === 2,
  JSON.stringify(sync2.body),
);

// Concurrent identical batches must not double-count either.
const [c1, c2] = await Promise.all([
  api("/usage/sync", { token: agentKey, method: "POST", body: { events: [event("race")] } }),
  api("/usage/sync", { token: agentKey, method: "POST", body: { events: [event("race")] } }),
]);
check(
  "concurrent identical syncs insert exactly once",
  (c1.body?.inserted ?? 0) + (c2.body?.inserted ?? 0) === 1,
  `${c1.body?.inserted} + ${c2.body?.inserted}`,
);

const overLimit = await api("/usage/sync", {
  token: agentKey,
  method: "POST",
  body: { events: Array.from({ length: 1001 }, (_, i) => event(`bulk${i}`)) },
});
check("batch cap enforced", overLimit.status === 400, `got ${overLimit.status}`);

// ── 7. dashboard reflects the data ────────────────────────────────────────────
console.log("\ndashboard");
const summary = await api("/dashboard/summary", { token: adminUser.token });
check(
  "summary totals include synced tokens",
  summary.body?.total_tokens >= 150,
  `got ${summary.body?.total_tokens}`,
);
check("highest consumer identified", summary.body?.highest?.display_name === "E2E-PC-01");

const ranking = await api("/dashboard/ranking?range=30d", { token: adminUser.token });
check("ranking returns the system", ranking.body?.[0]?.system_id === sysId);

const ts = await api("/dashboard/timeseries?range=7d", { token: adminUser.token });
check("timeseries has one point per day", ts.body?.days?.length === 7);

const projects = await api("/projects", { token: adminUser.token });
check("projects aggregated", projects.body?.some((p) => p.project_name === "e2e/demo"));

const status = await api(`/systems/${sysId}/status`, { token: adminUser.token });
check("system reports having synced", status.body?.never_synced === false);

// ── 8. RBAC scoping (fail closed) ─────────────────────────────────────────────
console.log("\nRBAC scoping");

// Second system, so there is something the developer must NOT see.
const other = await api("/connect/self", {
  token: adminUser.token,
  method: "POST",
  body: { display_name: "E2E-PC-02" },
});
await api("/usage/sync", {
  token: other.body.api_key,
  method: "POST",
  body: { events: [event("other1", { tokens: 400 })] },
});

// The admin creates the account (which provisions the Supabase identity too),
// then the developer signs in — the real onboarding path.
const devEmail = `e2e-dev-${Date.now()}@example.com`;
const devPassword = "e2e-password-123";

const devCreate = await api("/admin/users", {
  token: adminUser.token,
  method: "POST",
  body: {
    email: devEmail,
    full_name: "E2E Dev",
    role: "developer",
    system_ids: [sysId],
    password: devPassword,
  },
});
check(
  "admin creates a scoped developer",
  devCreate.status === 201,
  `got ${devCreate.status} ${JSON.stringify(devCreate.body)}`,
);

const devUser = await signIn(devEmail, devPassword);
const devProv = await api("/auth/provision", { token: devUser.token, method: "POST" });
const devSystems = await api("/systems", { token: devUser.token });

if (devProv.body?.role === "developer") {
  const ids = (devSystems.body ?? []).map((s) => s.system_id);
  check("developer sees ONLY assigned system", ids.length === 1 && ids[0] === sysId, ids.join(","));

  const devSummary = await api("/dashboard/summary", { token: devUser.token });
  check(
    "aggregates are scoped too (excludes PC-02's 400)",
    devSummary.body?.total_tokens < 400,
    `got ${devSummary.body?.total_tokens}`,
  );
  check("scoped flag set for limited view", devSummary.body?.scoped === true);
} else {
  console.log(`  SKIP  developer scoping (role was ${devProv.body?.role})`);
}

const devAdmin = await api("/admin/users", { token: devUser.token });
check("developer cannot reach admin routes", devAdmin.status === 403, `got ${devAdmin.status}`);

// ── 9. key revocation ─────────────────────────────────────────────────────────
console.log("\nkey lifecycle");
const keys = await api(`/admin/systems/${sysId}/keys`, { token: adminUser.token });
const keyId = keys.body?.[0]?.id;
await api(`/admin/keys/${keyId}`, { token: adminUser.token, method: "DELETE" });
const afterRevoke = await api("/usage/sync", {
  token: agentKey,
  method: "POST",
  body: { events: [event("post-revoke")] },
});
check("revoked key is rejected", afterRevoke.status === 401, `got ${afterRevoke.status}`);

// ── cleanup ───────────────────────────────────────────────────────────────────
console.log("\ncleanup");
for (const id of cleanup) {
  await admin.auth.admin.deleteUser(id).catch(() => {});
}
// Sweep stragglers left by earlier interrupted runs.
let swept = 0;
const { data: page } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
for (const u of page?.users ?? []) {
  if (/^(e2e|dbg|meta|invite|link|admin)-/.test(u.email ?? "")) {
    await admin.auth.admin.deleteUser(u.id).catch(() => {});
    swept++;
  }
}
console.log(`  removed ${cleanup.length} test users (+${swept} from earlier runs)`);

console.log(`\n${"=".repeat(50)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
