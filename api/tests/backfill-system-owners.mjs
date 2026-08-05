/**
 * Backfill `user_systems` for machines connected before ownership was recorded.
 *
 * Until now `connect/self` only linked the actor when they were a developer, so
 * a PC connected by an admin belonged to nobody — and the People and Sessions
 * pages, which build their rows from `user_systems`, showed nothing for it even
 * though the Overview counted its usage.
 *
 * The owner is not guessed: `audit_logs` records who ran the connect
 * (`system.connected` / `system.rekeyed`, target = system_id). Systems with no
 * such record, or whose actor no longer exists, are reported and left alone.
 *
 *   node tests/backfill-system-owners.mjs --dry-run   # show what would change
 *   node tests/backfill-system-owners.mjs             # apply
 */

import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv();

const DRY = process.argv.includes("--dry-run");

const sql = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await sql.connect();
await sql.query("set default_transaction_read_only = off");

const unowned = await sql.query(`
  select s.system_id, s.display_name,
         (select count(*) from usage_events u where u.system_id = s.system_id)::int as events,
         (select a.actor_email
            from audit_logs a
           where a.target = s.system_id
             and a.action in ('system.connected', 'system.rekeyed')
        order by a.at asc
           limit 1) as connected_by
    from systems s
   where not exists (select 1 from user_systems us where us.system_id = s.system_id)
order by s.created_at`);

if (unowned.rowCount === 0) {
  console.log("Every system already has an owner. Nothing to do.");
  await sql.end();
  process.exit(0);
}

console.log(`${DRY ? "[dry run] " : ""}systems with no owner: ${unowned.rowCount}\n`);
console.table(unowned.rows);

let linked = 0;
const skipped = [];

for (const row of unowned.rows) {
  if (!row.connected_by) {
    skipped.push(`${row.display_name}: no connect entry in audit_logs`);
    continue;
  }
  const user = await sql.query("select id from users where email = $1", [row.connected_by]);
  if (user.rowCount === 0) {
    skipped.push(`${row.display_name}: connecting user ${row.connected_by} no longer exists`);
    continue;
  }

  if (DRY) {
    console.log(`  would link ${row.display_name} -> ${row.connected_by}`);
    linked++;
    continue;
  }

  await sql.query(
    `insert into user_systems (user_id, system_id) values ($1, $2)
     on conflict (user_id, system_id) do nothing`,
    [user.rows[0].id, row.system_id],
  );
  console.log(`  linked ${row.display_name} -> ${row.connected_by}`);
  linked++;
}

console.log(`\n${DRY ? "would link" : "linked"}: ${linked}`);
if (skipped.length) {
  console.log("skipped (left untouched):");
  for (const s of skipped) console.log(`  - ${s}`);
}

const remaining = await sql.query(`
  select s.display_name, (select count(*) from usage_events u where u.system_id = s.system_id)::int events
    from systems s
   where not exists (select 1 from user_systems us where us.system_id = s.system_id)`);
console.log(`\nstill unowned: ${remaining.rowCount}`);
if (remaining.rowCount) console.table(remaining.rows);

await sql.end();
