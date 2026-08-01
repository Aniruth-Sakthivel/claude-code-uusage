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
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
