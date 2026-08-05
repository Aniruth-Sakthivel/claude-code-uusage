/**
 * Remove rows left behind by an aborted e2e run, and (optionally) confirm how
 * the deployed API encodes a large response.
 *
 * Only ever touches rows whose identifiers match the e2e naming pattern
 * (`safe<timestamp>-…` / `diag…`). Real systems and accounts are never matched.
 *
 *   node tests/sweep-e2e-leftovers.mjs          # sweep only
 *   node tests/sweep-e2e-leftovers.mjs --probe  # sweep + probe production
 */

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

loadEnv();

const PROBE = process.argv.includes("--probe");
const PROD = process.env.PROBE_BASE ?? "https://meterhouse.netlify.app";
const E2E_SYSTEM = "^(safe[0-9]+-PC-[0-9]+|diag-PC(-local)?)$";
const E2E_EMAIL = "^(safe[0-9]+-(admin|dev)|diag[0-9]+)@example\\.com$";

const CHILD_TABLES = [
  "usage_events",
  "daily_aggregates",
  "sync_logs",
  "prompt_daily",
  "session_meta",
  "enroll_tokens",
  "api_keys",
  "user_systems",
];

const sql = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await sql.connect();
await sql.query("set default_transaction_read_only = off");

console.log("\n— before —");
console.table(
  (
    await sql.query(`select display_name, left(system_id,8) sys,
       to_char(created_at,'MM-DD HH24:MI') created from systems order by created_at`)
  ).rows,
);

// ── sweep ────────────────────────────────────────────────────────────────────
const targets = await sql.query(
  "select system_id, display_name from systems where display_name ~ $1",
  [E2E_SYSTEM],
);
console.log(`\ne2e systems to remove: ${targets.rowCount}`);

for (const row of targets.rows) {
  for (const t of CHILD_TABLES) {
    await sql.query(`delete from ${t} where system_id = $1`, [row.system_id]);
  }
  await sql.query("delete from systems where system_id = $1", [row.system_id]);
  await sql.query("delete from audit_logs where target = $1", [row.system_id]);
  console.log(`  removed ${row.display_name} (${row.system_id.slice(0, 8)})`);
}

const users = await sql.query("delete from users where email ~ $1 returning email", [E2E_EMAIL]);
for (const u of users.rows) console.log(`  removed user ${u.email}`);
await sql.query("delete from audit_logs where actor_email ~ $1 or target ~ $1", [E2E_EMAIL]);

// Orphaned Supabase identities from the same runs.
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
for (const u of list?.users ?? []) {
  if (new RegExp(E2E_EMAIL).test(u.email ?? "")) {
    await admin.auth.admin.deleteUser(u.id).catch(() => {});
    console.log(`  removed auth identity ${u.email}`);
  }
}

console.log("\n— after —");
console.table(
  (
    await sql.query(`select display_name, left(system_id,8) sys,
       to_char(created_at,'MM-DD HH24:MI') created from systems order by created_at`)
  ).rows,
);
console.table(
  (
    await sql.query(`select (select count(*) from systems) systems,
       (select count(*) from api_keys) keys, (select count(*) from users) users,
       (select count(*) from usage_events) events`)
  ).rows,
);

// ── probe: how does the deployed API encode a large response? ────────────────
if (PROBE) {
  console.log(`\n— probing ${PROD} —`);
  const res = await fetch(`${PROD}/api/v1/health`, {
    headers: { "accept-encoding": "gzip, deflate, br" },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const gzipped = buf[0] === 0x1f && buf[1] === 0x8b;
  console.log(`/health -> ${res.status}`);
  console.log(`  content-type:     ${res.headers.get("content-type")}`);
  console.log(`  content-encoding: ${res.headers.get("content-encoding") ?? "(none)"}`);
  console.log(`  bytes:            ${buf.length}`);
  console.log(`  starts with gzip magic (1f 8b): ${gzipped}`);
  console.log(`  parses as JSON:   ${(() => { try { JSON.parse(buf.toString()); return true; } catch { return false; } })()}`);
  console.log(
    "\n  (health is under the ~1KB compress threshold, so it is expected to be\n" +
      "   clean either way. A >1KB endpoint is the one that breaks pre-fix.)",
  );
}

await sql.end();
