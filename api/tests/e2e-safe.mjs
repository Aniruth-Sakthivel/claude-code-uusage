/**
 * Non-destructive end-to-end test.
 *
 * Covers the same chain as `e2e-smoke.mjs` — provision, connect, enroll, agent
 * register, sync, dedup, dashboard, RBAC scoping — but WITHOUT the `truncate`
 * those suites open with. Everything it creates is tagged with a per-run id and
 * deleted at the end, so it is safe to run against a database that holds real
 * systems, keys, and user accounts.
 *
 * The trade-off vs. e2e-smoke.mjs: it cannot assert the "first user becomes
 * admin" bootstrap rule (that only fires on an empty `users` table). It creates
 * its throwaway admin by inserting the local row directly, then signs in — the
 * same path an admin-invited account takes.
 *
 *   node tests/e2e-safe.mjs
 *   API_BASE=https://meterhouse.netlify.app node tests/e2e-safe.mjs
 */

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

loadEnv();

const BASE = process.env.API_BASE ?? "http://127.0.0.1:8000";
const RUN = `safe${Date.now()}`;
const DAY = "2026-07-25";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const sql = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/** Everything this run created, torn down in `cleanup()`. */
const made = { systemIds: [], userIds: [], authUserIds: [], emails: [] };

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, extra = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

async function api(path, { token, method = "GET", body } = {}) {
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

/** GoTrue intermittently 500s on rapid admin calls; retry with backoff. */
async function createAuthUser(email, password, fullName) {
  let data, error;
  for (let attempt = 1; attempt <= 4; attempt++) {
    ({ data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    }));
    if (!error) break;
    if (attempt < 4) await sleep(attempt * 1500);
  }
  if (error) throw new Error(`createUser(${email}): ${error.message}`);
  made.authUserIds.push(data.user.id);
  made.emails.push(email);
  return data.user;
}

async function signIn(email, password) {
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn(${email}): ${error.message}`);
  return data.session.access_token;
}

function event(suffix, { tokens = 100, session = `${RUN}-sess`, day = DAY } = {}) {
  return {
    suffix: `${RUN}-${suffix}`,
    session_id: session,
    project_name: `${RUN}/demo`,
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

async function baseline() {
  const r = await sql.query(`
    select (select count(*) from systems)      as systems,
           (select count(*) from api_keys)     as api_keys,
           (select count(*) from users)        as users,
           (select count(*) from usage_events) as events`);
  return r.rows[0];
}

async function cleanup() {
  for (const id of made.systemIds) {
    // Child rows first — some have FKs, and this must work regardless of
    // whether they were declared with ON DELETE CASCADE.
    for (const t of [
      "usage_events",
      "daily_aggregates",
      "sync_logs",
      "prompt_daily",
      "session_meta",
      "enroll_tokens",
      "api_keys",
      "user_systems",
    ]) {
      await sql.query(`delete from ${t} where system_id = $1`, [id]).catch(() => {});
    }
    await sql.query("delete from systems where system_id = $1", [id]).catch(() => {});
  }
  for (const id of made.userIds) {
    await sql.query("delete from user_systems where user_id = $1", [id]).catch(() => {});
    await sql.query("delete from users where id = $1", [id]).catch(() => {});
  }
  if (made.emails.length) {
    await sql
      .query("delete from users where email = any($1)", [made.emails])
      .catch(() => {});
    await sql
      .query("delete from audit_logs where actor_email = any($1) or target = any($1)", [
        made.emails,
      ])
      .catch(() => {});
  }
  for (const id of made.systemIds) {
    await sql.query("delete from audit_logs where target = $1", [id]).catch(() => {});
  }
  for (const id of made.authUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nMeterhouse non-destructive e2e -> ${BASE}   (run id ${RUN})\n`);
await sql.connect();
/**
 * The transaction pooler reuses server connections without clearing session
 * state, so a `set default_transaction_read_only = on` issued by some other
 * client can still be in force on the backend we were handed. Clear it rather
 * than fail three steps in with a confusing "read-only transaction" error.
 * (Read-only tooling should scope that flag with `begin read only` per
 * transaction, never a session-level SET, for exactly this reason.)
 */
await sql.query("set default_transaction_read_only = off");
const before = await baseline();
console.log(
  `baseline: ${before.systems} systems, ${before.api_keys} keys, ` +
    `${before.users} users, ${before.events} events (all preserved)\n`,
);

try {
  // ── 1. health ──────────────────────────────────────────────────────────────
  console.log("health");
  const health = await api("/health");
  check("health ok", health.body?.status === "ok", JSON.stringify(health.body));
  check("database reachable", health.body?.database === "ok");

  // ── 2. throwaway admin ─────────────────────────────────────────────────────
  console.log("\nauth");
  const adminEmail = `${RUN}-admin@example.com`;
  const password = "safe-e2e-password-123";
  const authUser = await createAuthUser(adminEmail, password, "Safe E2E Admin");

  const ins = await sql.query(
    `insert into users (email, full_name, supabase_user_id, role_id)
     values ($1, $2, $3, (select id from roles where name = 'admin'))
     returning id`,
    [adminEmail, "Safe E2E Admin", authUser.id],
  );
  made.userIds.push(ins.rows[0].id);

  const adminToken = await signIn(adminEmail, password);
  const prov = await api("/auth/provision", { token: adminToken, method: "POST" });
  check("provision links existing account", prov.status === 200, JSON.stringify(prov.body));
  check("role is admin", prov.body?.role === "admin", `got ${prov.body?.role}`);
  check(
    "capabilities returned",
    Array.isArray(prov.body?.capabilities) && prov.body.capabilities.includes("manage_users"),
  );

  const me = await api("/auth/me", { token: adminToken });
  check("/auth/me works", me.status === 200 && me.body?.email === adminEmail);

  // ── 3. connect a PC ────────────────────────────────────────────────────────
  console.log("\nconnect");
  const connect = await api("/connect/self", {
    token: adminToken,
    method: "POST",
    body: { display_name: `${RUN}-PC-01`, environment: "personal" },
  });
  check("connect/self succeeds", connect.status === 200, `got ${connect.status}`);

  const sysId = connect.body?.system_id;
  const agentKey = connect.body?.api_key;
  if (sysId) made.systemIds.push(sysId);

  check("returns cfk_ api key", agentKey?.startsWith("cfk_"), String(agentKey).slice(0, 8));
  check(
    "returns one-line install command",
    typeof connect.body?.install_command === "string" &&
      connect.body.install_command.includes("| iex"),
  );

  // The URL that was wrong in production — assert it is now the configured one.
  // The generated command must point at the origin the request came in on —
  // that is the host the dashboard was just served from, so it is reachable by
  // definition. A configured PUBLIC_URL is only a fallback, precisely because
  // it can go stale and produce commands aimed at a host that no longer exists.
  const serverArg = connect.body?.manual_commands?.match(/--server '?([^\s']+)'?/)?.[1];
  const expectServer = (process.env.EXPECT_SERVER ?? BASE).replace(/\/$/, "");
  check(
    "register command points at the request origin",
    !!serverArg && serverArg === expectServer,
    `got ${serverArg}, expected ${expectServer}`,
  );
  check(
    "register command does NOT use the dead claude-code-usage host",
    !connect.body?.manual_commands?.includes("claude-code-usage.netlify.app"),
  );

  // ── 4. enroll token is single-use ──────────────────────────────────────────
  // The token is single-quoted inside the PowerShell command, so match the
  // token charset explicitly — `\S+` would swallow the closing quote and 404.
  const enrollPath = connect.body?.install_command?.match(
    /\/api\/v1\/connect\/script\/[A-Za-z0-9_-]+/,
  )?.[0];
  const first = await fetch(`${BASE}${enrollPath}`);
  const scriptText = await first.text();
  check("install script served", first.status === 200, `got ${first.status}`);
  check("script embeds the api key", scriptText.includes(agentKey));
  check("script schedules recurring scan+sync", scriptText.includes("schtasks"));

  const second = await fetch(`${BASE}${enrollPath}`);
  check("enroll token is single-use", second.status === 403, `got ${second.status}`);

  // ── 5. credential separation ───────────────────────────────────────────────
  console.log("\ncredential separation");
  const jwtOnAgent = await api("/usage/sync", {
    token: adminToken,
    method: "POST",
    body: { events: [event("nope")] },
  });
  check("user JWT rejected on agent route", jwtOnAgent.status === 401, `got ${jwtOnAgent.status}`);

  const keyOnAdmin = await api("/admin/users", { token: agentKey });
  check("agent key rejected on admin route", keyOnAdmin.status === 401, `got ${keyOnAdmin.status}`);

  const revokedShape = await api("/usage/sync", {
    token: "cfk_definitely-not-a-real-key",
    method: "POST",
    body: { events: [] },
  });
  check("unknown api key rejected", revokedShape.status === 401, `got ${revokedShape.status}`);

  // ── 6. agent register + heartbeat ──────────────────────────────────────────
  console.log("\nagent register / heartbeat");
  const reg = await api("/systems/register", {
    token: agentKey,
    method: "POST",
    body: { display_name: `${RUN}-PC-01`, hostname: "safe-e2e-host", agent_version: "0.2.2" },
  });
  check("agent registers", reg.status === 200 && reg.body?.system_id === sysId);
  check("commands array returned", Array.isArray(reg.body?.commands));

  const hb = await api("/systems/heartbeat", { token: agentKey, method: "POST" });
  check("heartbeat ok", hb.body?.ok === true);

  const afterReg = await sql.query(
    "select hostname, agent_version, last_seen_at from systems where system_id = $1",
    [sysId],
  );
  check("hostname persisted", afterReg.rows[0]?.hostname === "safe-e2e-host");
  check("agent_version persisted", afterReg.rows[0]?.agent_version === "0.2.2");
  check("last_seen_at stamped", afterReg.rows[0]?.last_seen_at !== null);

  const keyUse = await sql.query(
    "select last_used_at from api_keys where system_id = $1 order by id desc limit 1",
    [sysId],
  );
  check("api key last_used_at stamped", keyUse.rows[0]?.last_used_at !== null);

  // ── 7. sync + dedup ────────────────────────────────────────────────────────
  console.log("\nsync / dedup");
  const batch = [event("m1", { tokens: 100 }), event("m2", { tokens: 50 })];

  const s1 = await api("/usage/sync", { token: agentKey, method: "POST", body: { events: batch } });
  check(
    "first sync inserts both",
    s1.body?.inserted === 2 && s1.body?.duplicates === 0,
    JSON.stringify(s1.body),
  );

  const s2 = await api("/usage/sync", { token: agentKey, method: "POST", body: { events: batch } });
  check(
    "re-sync is all duplicates",
    s2.body?.inserted === 0 && s2.body?.duplicates === 2,
    JSON.stringify(s2.body),
  );

  const [c1, c2] = await Promise.all([
    api("/usage/sync", { token: agentKey, method: "POST", body: { events: [event("race")] } }),
    api("/usage/sync", { token: agentKey, method: "POST", body: { events: [event("race")] } }),
  ]);
  check(
    "concurrent identical syncs insert exactly once",
    (c1.body?.inserted ?? 0) + (c2.body?.inserted ?? 0) === 1,
    `${c1.body?.inserted} + ${c2.body?.inserted}`,
  );

  const dupInBatch = await api("/usage/sync", {
    token: agentKey,
    method: "POST",
    body: { events: [event("twice"), event("twice")] },
  });
  check(
    "duplicate within one batch collapses",
    dupInBatch.status === 200 && dupInBatch.body?.inserted === 1,
    JSON.stringify(dupInBatch.body),
  );

  const overLimit = await api("/usage/sync", {
    token: agentKey,
    method: "POST",
    body: { events: Array.from({ length: 1001 }, (_, i) => event(`bulk${i}`)) },
  });
  check("batch cap enforced", overLimit.status === 400, `got ${overLimit.status}`);

  // ── 8. prompt counts merge upward, never down ──────────────────────────────
  console.log("\nprompt counts / titles");
  await api("/usage/sync", {
    token: agentKey,
    method: "POST",
    body: {
      events: [],
      prompts: [{ session_id: `${RUN}-sess`, day: DAY, prompt_count: 5 }],
      session_titles: [{ session_id: `${RUN}-sess`, title: "safe e2e session" }],
    },
  });
  await api("/usage/sync", {
    token: agentKey,
    method: "POST",
    body: {
      events: [],
      prompts: [{ session_id: `${RUN}-sess`, day: DAY, prompt_count: 3 }],
      session_titles: [],
    },
  });
  const pc = await sql.query(
    "select prompt_count from prompt_daily where system_id = $1 and session_id = $2",
    [sysId, `${RUN}-sess`],
  );
  check(
    "out-of-order prompt count cannot decrease (greatest)",
    Number(pc.rows[0]?.prompt_count) === 5,
    `got ${pc.rows[0]?.prompt_count}`,
  );
  const title = await sql.query(
    "select title from session_meta where system_id = $1 and session_id = $2",
    [sysId, `${RUN}-sess`],
  );
  check("session title stored", title.rows[0]?.title === "safe e2e session");

  // ── 9. aggregates stay consistent with events ──────────────────────────────
  console.log("\nconsistency");
  const drift = await sql.query(
    `select coalesce(e.tok,0) as ev_tokens, coalesce(a.tok,0) as agg_tokens,
            coalesce(e.n,0) as ev_count,  coalesce(a.n,0) as agg_count
       from (select sum(total_tokens) tok, count(*) n from usage_events where system_id = $1) e
       full join (select sum(total_tokens) tok, sum(event_count) n from daily_aggregates where system_id = $1) a on true`,
    [sysId],
  );
  const d = drift.rows[0];
  check(
    "daily_aggregates match usage_events",
    d && d.ev_tokens === d.agg_tokens && d.ev_count === d.agg_count,
    JSON.stringify(d),
  );

  const counter = await sql.query(
    `select s.total_events, (select count(*) from usage_events where system_id = s.system_id) actual
       from systems s where s.system_id = $1`,
    [sysId],
  );
  check(
    "systems.total_events matches actual",
    String(counter.rows[0]?.total_events) === String(counter.rows[0]?.actual),
    JSON.stringify(counter.rows[0]),
  );

  const logs = await sql.query("select count(*) n from sync_logs where system_id = $1", [sysId]);
  check("sync_logs written", Number(logs.rows[0]?.n) > 0, JSON.stringify(logs.rows[0]));

  // ── 10. dashboard reflects it ──────────────────────────────────────────────
  console.log("\ndashboard");
  const status = await api(`/systems/${sysId}/status`, { token: adminToken });
  check("system reports having synced", status.body?.never_synced === false);

  const projects = await api("/projects", { token: adminToken });
  check(
    "project appears in aggregation",
    Array.isArray(projects.body) && projects.body.some((p) => p.project_name === `${RUN}/demo`),
  );

  const summary = await api("/dashboard/summary", { token: adminToken });
  check("summary returns totals", typeof summary.body?.total_tokens === "number");

  const ts = await api("/dashboard/timeseries?range=7d", { token: adminToken });
  check("timeseries has one point per day", ts.body?.days?.length === 7);

  const ranking = await api("/dashboard/ranking?range=30d", { token: adminToken });
  check("ranking returns rows", Array.isArray(ranking.body));

  // ── 11. RBAC scoping fails closed ──────────────────────────────────────────
  console.log("\nRBAC scoping");
  const devEmail = `${RUN}-dev@example.com`;
  const devPassword = "safe-e2e-password-123";
  const devCreate = await api("/admin/users", {
    token: adminToken,
    method: "POST",
    body: {
      email: devEmail,
      full_name: "Safe E2E Dev",
      role: "developer",
      system_ids: [sysId],
      password: devPassword,
    },
  });
  check("admin creates scoped developer", devCreate.status === 201, JSON.stringify(devCreate.body));

  if (devCreate.status === 201) {
    made.emails.push(devEmail);
    if (devCreate.body?.id) made.userIds.push(devCreate.body.id);
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const devAuth = list?.users?.find((u) => u.email === devEmail);
    if (devAuth) made.authUserIds.push(devAuth.id);

    const devToken = await signIn(devEmail, devPassword);
    await api("/auth/provision", { token: devToken, method: "POST" });

    const devSystems = await api("/systems", { token: devToken });
    const ids = (devSystems.body ?? []).map((s) => s.system_id);
    check(
      "developer sees ONLY the assigned system",
      ids.length === 1 && ids[0] === sysId,
      ids.join(","),
    );

    const devSummary = await api("/dashboard/summary", { token: devToken });
    check("scoped flag set for limited view", devSummary.body?.scoped === true);

    const devAdmin = await api("/admin/users", { token: devToken });
    check("developer blocked from admin routes", devAdmin.status === 403, `got ${devAdmin.status}`);
  }
} catch (err) {
  failed++;
  failures.push(`threw: ${err.message}`);
  console.log(`\n  ERROR  ${err.stack}`);
} finally {
  console.log("\ncleanup");
  await cleanup();
  const after = await baseline();
  const restored =
    after.systems === before.systems &&
    after.api_keys === before.api_keys &&
    after.users === before.users &&
    after.events === before.events;
  check(
    "database restored to baseline",
    restored,
    `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
  );
  await sql.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(`failing: ${failures.join(" | ")}`);
process.exit(failed === 0 ? 0 : 1);
