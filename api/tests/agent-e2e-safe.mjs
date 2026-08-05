/**
 * End-to-end test driving the REAL Python agent — non-destructive.
 *
 * Runs the actual `meterhouse` CLI (register → scan → sync) against the API and
 * checks the resulting rows in the database, then deletes everything it made.
 *
 * Isolation: the agent is launched with HOME/USERPROFILE pointed at a temp
 * directory containing a synthetic transcript, so it never reads this machine's
 * real `~/.claude/projects` data and never writes to the real agent config or
 * local usage.db.
 *
 *   node tests/agent-e2e-safe.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

loadEnv();

const BASE = process.env.API_BASE ?? "http://127.0.0.1:8000";
const AGENT_DIR = path.resolve(process.cwd(), "..", "agent");
const RUN = `agt${Date.now()}`;

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, ok, extra = "") => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
};

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const sql = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const made = { systemIds: [], userIds: [], authUserIds: [], emails: [] };
let sandbox;

/** One assistant turn in Claude Code's transcript format. */
function assistantRecord({ session, ts, inp, out, cacheRead = 0, cacheCreate = 0 }) {
  return JSON.stringify({
    type: "assistant",
    sessionId: session,
    timestamp: ts,
    cwd: "/home/e2e/synthetic-project",
    gitBranch: "main",
    message: {
      id: `${session}-${ts}`,
      model: "claude-opus-4-8",
      usage: {
        input_tokens: inp,
        output_tokens: out,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      },
      content: [],
    },
  });
}

function makeSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meterhouse-e2e-"));
  const projects = path.join(dir, ".claude", "projects", "-home-e2e-synthetic-project");
  mkdirSync(projects, { recursive: true });

  const session = `${RUN}-session`;
  const lines = [
    assistantRecord({ session, ts: "2026-07-22T10:00:00.000Z", inp: 1200, out: 340 }),
    assistantRecord({ session, ts: "2026-07-22T10:05:00.000Z", inp: 800, out: 210, cacheRead: 500 }),
    assistantRecord({ session, ts: "2026-07-22T10:09:00.000Z", inp: 640, out: 120, cacheCreate: 90 }),
  ];
  writeFileSync(path.join(projects, `${session}.jsonl`), lines.join("\n") + "\n", "utf8");

  return {
    dir,
    expectedEvents: lines.length,
    expectedTokens: 1200 + 340 + 800 + 210 + 500 + 640 + 120 + 90,
  };
}

/** Run the agent CLI inside the sandbox. Returns stdout (stderr merged). */
function agent(args) {
  return execFileSync("python", ["-m", "meterhouse", ...args], {
    cwd: AGENT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: sandbox.dir,
      USERPROFILE: sandbox.dir,
      METERHOUSE_CONFIG: path.join(sandbox.dir, "agent.json"),
      METERHOUSE_RUNTIME_CONFIG: path.join(sandbox.dir, "runtime.json"),
      METERHOUSE_DB: path.join(sandbox.dir, "usage.db"),
      PYTHONIOENCODING: "utf-8",
    },
  });
}

async function cleanup() {
  for (const id of made.systemIds) {
    for (const t of [
      "usage_events", "daily_aggregates", "sync_logs", "prompt_daily",
      "session_meta", "enroll_tokens", "api_keys", "user_systems",
    ]) {
      await sql.query(`delete from ${t} where system_id = $1`, [id]).catch(() => {});
    }
    await sql.query("delete from systems where system_id = $1", [id]).catch(() => {});
    await sql.query("delete from audit_logs where target = $1", [id]).catch(() => {});
  }
  for (const id of made.userIds) {
    await sql.query("delete from user_systems where user_id = $1", [id]).catch(() => {});
    await sql.query("delete from users where id = $1", [id]).catch(() => {});
  }
  if (made.emails.length) {
    await sql.query("delete from users where email = any($1)", [made.emails]).catch(() => {});
    await sql
      .query("delete from audit_logs where actor_email = any($1) or target = any($1)", [made.emails])
      .catch(() => {});
  }
  for (const id of made.authUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  if (sandbox?.dir) rmSync(sandbox.dir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nMeterhouse REAL-AGENT e2e -> ${BASE}   (run ${RUN})\n`);
await sql.connect();
await sql.query("set default_transaction_read_only = off");

const before = (
  await sql.query(
    `select (select count(*) from systems) systems, (select count(*) from api_keys) keys,
            (select count(*) from users) users, (select count(*) from usage_events) events`,
  )
).rows[0];
console.log(`baseline: ${JSON.stringify(before)}\n`);

try {
  sandbox = makeSandbox();
  console.log(`sandbox HOME: ${sandbox.dir}`);
  console.log(`synthetic transcript: 3 turns, ${sandbox.expectedTokens} tokens\n`);

  // ── agent is installed and runnable ────────────────────────────────────────
  console.log("agent cli");
  const help = agent(["--help"]);
  check("CLI runs", help.includes("meterhouse") || help.includes("usage"));

  // ── provision an admin + connect a PC through the API ──────────────────────
  console.log("\nprovision");
  const email = `${RUN}-admin@example.com`;
  const password = "agent-e2e-password-123";
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: "Agent E2E" },
  });
  if (cErr) throw new Error(`createUser: ${cErr.message}`);
  made.authUserIds.push(created.user.id);
  made.emails.push(email);

  const ins = await sql.query(
    `insert into users (email, full_name, supabase_user_id, role_id)
     values ($1,$2,$3,(select id from roles where name='admin')) returning id`,
    [email, "Agent E2E", created.user.id],
  );
  made.userIds.push(ins.rows[0].id);

  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error(`signIn: ${sErr.message}`);
  const token = sess.session.access_token;

  const connectRes = await fetch(`${BASE}/api/v1/connect/self`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ display_name: `${RUN}-PC` }),
  });
  const connect = await connectRes.json();
  check("connect/self returns a key", connect?.api_key?.startsWith("cfk_"), JSON.stringify(connect).slice(0, 120));
  const sysId = connect.system_id;
  if (sysId) made.systemIds.push(sysId);

  // ── the actual agent commands ──────────────────────────────────────────────
  console.log("\nagent register");
  const regOut = agent([
    "register", "--server", BASE, "--api-key", connect.api_key, "--display-name", `${RUN}-PC`,
  ]);
  check("register reports success", /Registered with central server/i.test(regOut), regOut.trim().split("\n").pop());
  check("register did NOT fall back to 'call failed'", !/registration call failed/i.test(regOut), regOut.trim());

  const afterReg = await sql.query(
    "select hostname, agent_version, last_seen_at from systems where system_id = $1", [sysId]);
  check("server recorded hostname", !!afterReg.rows[0]?.hostname, JSON.stringify(afterReg.rows[0]));
  check("server recorded agent_version", !!afterReg.rows[0]?.agent_version, JSON.stringify(afterReg.rows[0]));

  console.log("\nagent scan");
  const scanOut = agent(["scan"]);
  check("scan completes", !/Traceback/.test(scanOut), scanOut.trim().slice(-200));

  console.log("\nagent sync");
  const syncOut = agent(["sync"]);
  check("sync reports completion", /Sync complete/i.test(syncOut), syncOut.trim().slice(-200));
  check("sync did not report failure", !/Sync failed/i.test(syncOut), syncOut.trim().slice(-200));

  const rows = await sql.query(
    "select count(*) n, coalesce(sum(total_tokens),0) tok from usage_events where system_id = $1",
    [sysId],
  );
  check(
    "events from the synthetic transcript landed",
    Number(rows.rows[0].n) === sandbox.expectedEvents,
    `got ${rows.rows[0].n}, expected ${sandbox.expectedEvents}`,
  );
  check(
    "token totals match the transcript",
    Number(rows.rows[0].tok) === sandbox.expectedTokens,
    `got ${rows.rows[0].tok}, expected ${sandbox.expectedTokens}`,
  );

  const proj = await sql.query(
    "select distinct project_name from usage_events where system_id = $1", [sysId]);
  check("project name derived from cwd", proj.rows.length === 1, JSON.stringify(proj.rows));

  // ── re-sync must not double count ──────────────────────────────────────────
  console.log("\nagent re-sync (idempotency)");
  const syncOut2 = agent(["sync"]);
  const rows2 = await sql.query(
    "select count(*) n, coalesce(sum(total_tokens),0) tok from usage_events where system_id = $1",
    [sysId],
  );
  check(
    "re-sync inserts nothing new",
    Number(rows2.rows[0].n) === sandbox.expectedEvents &&
      Number(rows2.rows[0].tok) === sandbox.expectedTokens,
    `${rows2.rows[0].n} events / ${rows2.rows[0].tok} tokens`,
  );
  check("re-sync reported no failure", !/Sync failed/i.test(syncOut2), syncOut2.trim().slice(-160));

  // ── aggregates + dashboard reflect the agent's data ────────────────────────
  console.log("\nrollups");
  const agg = await sql.query(
    `select coalesce(sum(total_tokens),0) tok, coalesce(sum(event_count),0) n
       from daily_aggregates where system_id = $1`, [sysId]);
  check(
    "daily_aggregates match events",
    Number(agg.rows[0].tok) === sandbox.expectedTokens &&
      Number(agg.rows[0].n) === sandbox.expectedEvents,
    JSON.stringify(agg.rows[0]),
  );

  const statusRes = await fetch(`${BASE}/api/v1/systems/${sysId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const status = await statusRes.json();
  check("dashboard shows the PC as synced", status?.never_synced === false, JSON.stringify(status).slice(0, 160));

  console.log("\nagent health");
  const healthOut = agent(["health"]);
  check("health command runs", !/Traceback/.test(healthOut), healthOut.trim().slice(-160));
} catch (err) {
  failed++;
  failures.push(`threw: ${err.message}`);
  console.log(`\n  ERROR  ${err.stack ?? err}`);
  if (err.stdout) console.log(`  stdout: ${String(err.stdout).slice(-800)}`);
  if (err.stderr) console.log(`  stderr: ${String(err.stderr).slice(-800)}`);
} finally {
  console.log("\ncleanup");
  await cleanup();
  const after = (
    await sql.query(
      `select (select count(*) from systems) systems, (select count(*) from api_keys) keys,
              (select count(*) from users) users, (select count(*) from usage_events) events`,
    )
  ).rows[0];
  check(
    "database restored to baseline",
    JSON.stringify(after) === JSON.stringify(before),
    `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
  );
  await sql.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(`failing: ${failures.join(" | ")}`);
process.exit(failed === 0 ? 0 : 1);
