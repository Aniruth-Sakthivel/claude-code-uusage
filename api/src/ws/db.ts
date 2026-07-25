/**
 * Dedicated DB pool for the WebSocket server.
 *
 * Deliberately NOT the shared pool in db/client.ts: that one is tuned for
 * serverless (max: 1, allowExitOnIdle: true in production) because each
 * Netlify function instance handles one request and should let Node exit when
 * idle. This process is the opposite shape — one long-lived Node process
 * holding many concurrent WebSocket connections — so it gets its own pool
 * sized and configured for that.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { config } from "../config.js";
import * as schema from "../db/schema.js";

const { Pool } = pg;

export const wsPool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: false,
  ssl: config.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

wsPool.on("error", (err) => {
  console.error("[ws-db] idle client error:", err.message);
});

export const wsDb = drizzle(wsPool, { schema });

export async function closeWsDb(): Promise<void> {
  await wsPool.end();
}
