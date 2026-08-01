/**
 * Full-product verification with the REAL Python agent.
 *
 * This is the test the project never had: it drives the actual flow a user
 * follows — create the admin account, click "Connect this PC", run the returned
 * install script, and confirm real transcript data reaches the dashboard.
 *
 *   node tests/real-agent-flow.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv();

const BASE = process.env.API_BASE ?? "http://127.0.0.1:8000";
const REPO = path.resolve(process.cwd(), "..");
const AGENT_DIR = path.join(REPO, "agent");

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const step = (s) => console.log(`\n${s}`);
const ok = (s) => console.log(`  OK    ${s}`);
const fail = (s) => {
  console.log(`  FAIL  ${s}`);
  process.exitCode = 1;
};

async function api(pathname, { token, method = "GET", body } = {}) {
  const res = await fetch(`${BASE}/api/v1${pathname}`, {
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
    /* empty body */
  }
  return { status: res.status, body: json };
}

console.log("Meterhouse — real agent end-to-end verification");

// ── reset ─────────────────────────────────────────────────────────────────────
step("0. Reset");
{
  const pg = (await import("pg")).default;
  const c = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query(`truncate table usage_events, daily_aggregates, sync_logs,
    enroll_tokens, api_keys, user_systems, systems, audit_logs, users
    restart identity cascade`);
  await c.end();

  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of data?.users ?? []) {
    if (/^(e2e|dbg|meta|invite|link|real)-/.test(u.email ?? "")) {
      await admin.auth.admin.deleteUser(u.id).catch(() => {});
    }
  }
  ok("database cleared");
}

// ── 1. admin signs up ─────────────────────────────────────────────────────────
step("1. First user becomes admin");
const email = `real-admin-${Date.now()}@example.com`;
const password = "real-password-123";

const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: "Real Admin" },
});
if (createErr) throw new Error(createErr.message);

const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: sess } = await anon.auth.signInWithPassword({ email, password });
const token = sess.session.access_token;

const prov = await api("/auth/provision", { token, method: "POST" });
prov.body?.role === "admin" ? ok(`admin provisioned (${email})`) : fail("provision");

// ── 2. click "Connect this PC" ────────────────────────────────────────────────
step("2. Connect this PC");
const hostname = os.hostname();
const connect = await api("/connect/self", {
  token,
  method: "POST",
  body: { display_name: hostname },
});
if (connect.status !== 200) {
  fail(`connect/self returned ${connect.status}`);
  process.exit(1);
}
ok(`system created for "${hostname}"`);
ok(`install command: ${connect.body.install_command.slice(0, 60)}...`);

const apiKey = connect.body.api_key;
const systemId = connect.body.system_id;

// ── 3. run the REAL agent ─────────────────────────────────────────────────────
step("3. Run the real Python agent");

if (!existsSync(AGENT_DIR)) {
  fail(`agent directory not found at ${AGENT_DIR}`);
  process.exit(1);
}

function runAgent(args) {
  return execFileSync("python", ["-m", "meterhouse", ...args], {
    cwd: AGENT_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      // Isolated config + DB so a developer's real agent state is untouched.
      METERHOUSE_CONFIG: path.join(os.tmpdir(), "cf-verify-agent.json"),
      METERHOUSE_DB: path.join(os.tmpdir(), "cf-verify-usage.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  runAgent(["register", "--server", BASE, "--api-key", apiKey, "--display-name", hostname]);
  ok("agent registered");
} catch (e) {
  fail(`register failed: ${String(e.stderr || e.message).slice(0, 200)}`);
  process.exit(1);
}

let scanOut = "";
try {
  scanOut = runAgent(["scan"]);
  const m = scanOut.match(/events\+=(\d+)/);
  const events = m ? Number(m[1]) : 0;
  events > 0
    ? ok(`scanned real transcripts — ${events} events found`)
    : console.log("  WARN  scan found 0 events (no Claude Code transcripts on this PC?)");
} catch (e) {
  fail(`scan failed: ${String(e.stderr || e.message).slice(0, 200)}`);
}

try {
  const syncOut = runAgent(["sync"]);
  const m = syncOut.match(/inserted=(\d+)/);
  ok(`synced to dashboard — inserted=${m ? m[1] : "?"}`);
} catch (e) {
  fail(`sync failed: ${String(e.stderr || e.message).slice(0, 200)}`);
}

// ── 4. dashboard reflects real data ───────────────────────────────────────────
step("4. Dashboard shows the real data");

const summary = await api("/dashboard/summary", { token });
const total = summary.body?.total_tokens ?? 0;
total > 0
  ? ok(`total tracked tokens: ${total.toLocaleString()}`)
  : fail("dashboard shows 0 tokens");

const systems = await api("/systems", { token });
const sys = systems.body?.[0];
sys && !sys.never_synced
  ? ok(`"${sys.display_name}" reports synced, ${sys.sessions} sessions, ${sys.projects} projects`)
  : fail("system still reports never_synced");

const projects = await api("/projects", { token });
(projects.body?.length ?? 0) > 0
  ? ok(`${projects.body.length} projects aggregated`)
  : fail("no projects");

const ts = await api("/dashboard/timeseries?range=7d", { token });
const nonZeroDays = (ts.body?.points ?? []).filter(
  (p) => Object.values(p.values).some((v) => v > 0),
).length;
nonZeroDays > 0
  ? ok(`timeseries has ${nonZeroDays} day(s) with activity`)
  : fail("timeseries is empty");

// ── 5. idempotency on real data ───────────────────────────────────────────────
step("5. Re-scan does not double count");
const before = (await api("/dashboard/summary", { token })).body.total_tokens;
runAgent(["scan"]);
try {
  runAgent(["sync"]);
} catch {
  /* nothing new to send is fine */
}
const after = (await api("/dashboard/summary", { token })).body.total_tokens;
before === after
  ? ok(`total unchanged after re-scan (${after.toLocaleString()})`)
  : fail(`total changed: ${before} -> ${after}`);

// ── done ──────────────────────────────────────────────────────────────────────
step("Cleanup");
await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
ok("test user removed");

console.log(
  process.exitCode
    ? "\nSome checks failed.\n"
    : `\nAll checks passed — real usage data is flowing end to end.\nSystem id: ${systemId}\n`,
);
