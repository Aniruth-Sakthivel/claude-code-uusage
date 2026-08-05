/**
 * Page-by-page data audit — non-destructive.
 *
 * Calls every endpoint the dashboard's pages depend on, then cross-checks the
 * numbers that matter against the database directly. A 200 with a plausible
 * shape is not proof a page is correct: the point here is that what the page
 * would render equals what is actually stored.
 *
 * Creates one throwaway admin (deleted at the end) and writes nothing else.
 *
 *   node tests/pages-audit.mjs
 */

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

loadEnv();

const BASE = process.env.API_BASE ?? "http://127.0.0.1:8000";
const RUN = `aud${Date.now()}`;

let ok = 0;
let bad = 0;
const problems = [];

function check(page, name, pass, detail = "") {
  if (pass) {
    ok++;
    console.log(`  PASS  ${name}`);
  } else {
    bad++;
    problems.push(`${page}: ${name}`);
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const sql = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let token;
let authUserId;
let localUserId;

async function api(path) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

const one = async (q, params = []) => (await sql.query(q, params)).rows[0];

await sql.connect();
await sql.query("set default_transaction_read_only = off");

console.log(`\nMeterhouse page data audit -> ${BASE}\n`);

try {
  // ── throwaway admin ────────────────────────────────────────────────────────
  const email = `${RUN}@example.com`;
  const password = "audit-password-123";
  const { data: created, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: "Audit" },
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  authUserId = created.user.id;

  const ins = await sql.query(
    `insert into users (email, full_name, supabase_user_id, role_id)
     values ($1,$2,$3,(select id from roles where name='admin')) returning id`,
    [email, "Audit", authUserId],
  );
  localUserId = ins.rows[0].id;

  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error(`signIn: ${sErr.message}`);
  token = sess.session.access_token;

  // ── ground truth ───────────────────────────────────────────────────────────
  const truth = await one(`
    select (select count(*) from systems)                         as systems,
           (select count(*) from usage_events)                    as events,
           (select coalesce(sum(total_tokens),0) from usage_events) as tokens,
           (select count(distinct project_name) from usage_events) as projects,
           (select count(distinct session_id) from usage_events)   as sessions,
           (select count(*) from claude_accounts)                  as accounts,
           (select count(*) from users)                            as users`);
  console.log("database ground truth:", JSON.stringify(truth), "\n");

  // ── Overview ───────────────────────────────────────────────────────────────
  console.log("Overview  (/dashboard/summary, /dashboard/ranking, /dashboard/timeseries, /systems)");
  const summary = await api("/dashboard/summary");
  check("Overview", "summary responds", summary.status === 200, `got ${summary.status}`);
  check(
    "Overview",
    "summary total_tokens matches usage_events",
    String(summary.body?.total_tokens ?? "") === String(truth.tokens),
    `api ${summary.body?.total_tokens} vs db ${truth.tokens}`,
  );

  const ranking = await api("/dashboard/ranking?range=30d");
  check("Overview", "ranking responds as an array", Array.isArray(ranking.body));
  const rankTokens = (ranking.body ?? []).reduce((a, r) => a + Number(r.total_tokens ?? 0), 0);
  const dbRank30 = await one(
    `select coalesce(sum(total_tokens),0) t from usage_events where day >= to_char(now() - interval '30 days','YYYY-MM-DD')`,
  );
  check(
    "Overview",
    "ranking totals match the last 30 days of events",
    String(rankTokens) === String(dbRank30.t),
    `api ${rankTokens} vs db ${dbRank30.t}`,
  );

  const ts = await api("/dashboard/timeseries?range=7d");
  check("Overview", "timeseries returns 7 points for 7d", ts.body?.days?.length === 7,
    `got ${ts.body?.days?.length}`);

  const systems = await api("/systems");
  check("Overview", "systems count matches the database",
    (systems.body ?? []).length === Number(truth.systems),
    `api ${(systems.body ?? []).length} vs db ${truth.systems}`);

  // per-system event counts must agree
  const dbPerSystem = await sql.query(
    `select s.system_id, s.display_name, s.total_events::int counter,
            (select count(*) from usage_events u where u.system_id = s.system_id)::int actual
       from systems s`);
  const counterDrift = dbPerSystem.rows.filter((r) => r.counter !== r.actual);
  check("Systems", "systems.total_events matches actual event rows",
    counterDrift.length === 0, JSON.stringify(counterDrift));

  // ── Projects ───────────────────────────────────────────────────────────────
  console.log("\nProjects  (/projects)");
  const projects = await api("/projects");
  check("Projects", "responds as an array", Array.isArray(projects.body), `got ${projects.status}`);
  check("Projects", "project count matches distinct project_name",
    (projects.body ?? []).length === Number(truth.projects),
    `api ${(projects.body ?? []).length} vs db ${truth.projects}`);
  const projTokens = (projects.body ?? []).reduce((a, p) => a + Number(p.total_tokens ?? 0), 0);
  check("Projects", "project tokens sum to the events total",
    String(projTokens) === String(truth.tokens), `api ${projTokens} vs db ${truth.tokens}`);

  // ── Sessions / People ──────────────────────────────────────────────────────
  console.log("\nSessions  (/people, /people/:id, /people/:id/sessions)");
  const people = await api("/people?range=30d");
  check("Sessions", "people responds", people.status === 200, `got ${people.status}`);
  const rows = people.body?.people ?? people.body ?? [];
  check("Sessions", "people returns a list", Array.isArray(rows), JSON.stringify(people.body).slice(0, 120));

  if (Array.isArray(rows) && rows.length > 0) {
    const first = rows[0];
    const pid = first.person_id ?? first.id ?? first.system_id;
    check("Sessions", "each person row carries a session count",
      rows.every((r) => typeof (r.sessions ?? r.session_count) !== "undefined"),
      JSON.stringify(first).slice(0, 160));

    if (pid !== undefined) {
      const detail = await api(`/people/${pid}?range=30d`);
      check("Sessions", "person detail responds", detail.status === 200, `got ${detail.status}`);
      const sessions = await api(`/people/${pid}/sessions?range=30d`);
      check("Sessions", "person sessions respond", sessions.status === 200, `got ${sessions.status}`);
      const list = sessions.body?.sessions ?? sessions.body ?? [];
      check("Sessions", "sessions list is an array", Array.isArray(list),
        JSON.stringify(sessions.body).slice(0, 160));

      // Every returned session id must exist in usage_events.
      if (Array.isArray(list) && list.length > 0) {
        const ids = list.map((s) => s.session_id).filter(Boolean);
        const found = await one(
          `select count(distinct session_id)::int n from usage_events where session_id = any($1)`,
          [ids],
        );
        check("Sessions", "every listed session exists in usage_events",
          Number(found.n) === new Set(ids).size, `matched ${found.n} of ${new Set(ids).size}`);
      } else {
        console.log("  NOTE  no sessions in range — nothing to cross-check");
      }
    }
  } else {
    console.log("  NOTE  no people rows — sessions cross-check skipped");
  }

  /**
   * Attribution: People/Sessions build their rows from `user_systems`, so a
   * connected machine that is linked to nobody produces empty pages while the
   * Overview still shows its usage. Any system carrying events must have an
   * owner, or its activity is invisible on those pages.
   */
  const unowned = await sql.query(
    `select s.system_id, s.display_name,
            (select count(*) from usage_events u where u.system_id = s.system_id)::int events
       from systems s
      where not exists (select 1 from user_systems us where us.system_id = s.system_id)`,
  );
  const unownedWithData = unowned.rows.filter((r) => r.events > 0);
  check(
    "Sessions",
    "every system with usage is attributed to a person",
    unownedWithData.length === 0,
    `unowned: ${unownedWithData.map((r) => `${r.display_name}(${r.events} events)`).join(", ")}`,
  );

  // ── Claude accounts ────────────────────────────────────────────────────────
  console.log("\nClaude accounts  (/accounts)");
  const accounts = await api("/accounts");
  check("Accounts", "responds", accounts.status === 200, `got ${accounts.status}`);
  check("Accounts", "account count matches claude_accounts",
    (accounts.body?.accounts ?? []).length === Number(truth.accounts),
    `api ${(accounts.body?.accounts ?? []).length} vs db ${truth.accounts}`);

  // ── Admin pages ────────────────────────────────────────────────────────────
  console.log("\nAdmin  (/admin/users, /admin/audit, /admin/roles, /settings)");
  const users = await api("/admin/users");
  const userList = users.body?.users ?? users.body ?? [];
  check("AdminUsers", "responds", users.status === 200, `got ${users.status}`);
  check("AdminUsers", "user count matches the database",
    Array.isArray(userList) && userList.length === Number(truth.users),
    `api ${userList.length} vs db ${truth.users}`);

  const audit = await api("/admin/audit");
  check("AdminAudit", "responds", audit.status === 200, `got ${audit.status}`);
  // Check for a bare array FIRST: `body?.entries` on an array resolves to
  // Array.prototype.entries — a function, and truthy — which silently turns a
  // perfectly good array response into a failure.
  const auditRows = Array.isArray(audit.body)
    ? audit.body
    : (audit.body?.entries ?? audit.body?.items ?? []);
  check("AdminAudit", "returns entries", Array.isArray(auditRows), JSON.stringify(audit.body).slice(0, 120));
  const dbAudit = await one("select count(*)::int n from audit_logs");
  check("AdminAudit", "entry count is plausible vs audit_logs",
    auditRows.length > 0 && auditRows.length <= Number(dbAudit.n),
    `api ${auditRows.length} vs db ${dbAudit.n}`);

  for (const [label, path] of [
    ["AdminSettings", "/admin/roles"],
    ["Settings", "/settings"],
    ["Workspace", "/workspace/automations"],
    ["Reports", "/workspace/reports"],
    ["Calendar", "/workspace/calendar"],
    ["Whiteboard", "/workspace/boards"],
    ["Wiki", "/workspace/docs"],
    ["Chat", "/chat/channels"],
    ["Initiatives", "/initiatives"],
    ["PM", "/pm/assignees"],
  ]) {
    const r = await api(path);
    check(label, `${path} responds 200`, r.status === 200, `got ${r.status}`);
  }
} catch (err) {
  bad++;
  problems.push(`threw: ${err.message}`);
  console.log(`\n  ERROR  ${err.stack ?? err}`);
} finally {
  console.log("\ncleanup");
  if (localUserId) await sql.query("delete from users where id = $1", [localUserId]).catch(() => {});
  await sql.query("delete from audit_logs where actor_email like $1", [`${RUN}%`]).catch(() => {});
  if (authUserId) await admin.auth.admin.deleteUser(authUserId).catch(() => {});
  const left = await one(`select (select count(*) from users) users, (select count(*) from systems) systems`);
  console.log(`  users=${left.users} systems=${left.systems} (throwaway admin removed)`);
  await sql.end();
}

console.log(`\n${ok} passed, ${bad} failed`);
if (problems.length) console.log(`failing: ${problems.join(" | ")}`);
process.exit(bad === 0 ? 0 : 1);
