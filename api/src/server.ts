/**
 * Local development entry point.
 *
 *   npm run dev    # http://127.0.0.1:8000
 *
 * Netlify uses src/netlify.ts instead; both share buildApp().
 */

import { config } from "./config.js";
import { buildApp } from "./index.js";
import { seedRoles } from "./services/auth.js";

async function main() {
  const app = await buildApp();

  // Roles are reference data, not schema — seeding here keeps first run to a
  // single command. Migrations own the tables themselves.
  await seedRoles();

  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port: config.PORT, host });

  const line = "=".repeat(60);
  console.log(`\n${line}`);
  console.log("  Meterhouse API");
  console.log(line);
  console.log(`  URL:      http://${host}:${config.PORT}`);
  console.log(`  Health:   http://${host}:${config.PORT}/api/v1/health`);
  console.log(`  Database: ${config.DATABASE_URL.replace(/:[^:@/]+@/, ":****@")}`);
  console.log(`${line}\n`);

  // Only meaningful here: this is the one persistent process among the app's
  // entry points (src/netlify.ts is one-invocation-per-request and has no
  // connections to drain). Stop accepting new requests, let in-flight ones
  // finish, then release the DB pool — a plain SIGKILL/crash would otherwise
  // drop in-flight requests and can leave a connection dangling in Postgres
  // until it times out server-side.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    try {
      await app.close(); // waits for in-flight requests, per Fastify's own semantics
      const { closeDb } = await import("./db/client.js");
      await closeDb();
      console.log("Shutdown complete.");
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
