// Production migration runner (deployment readiness Step 2).
//
// Plain Node ESM using only production dependencies (drizzle-orm, pg) — no
// tsx, no .env.local, no Next.js. It needs exactly one setting:
//   DATABASE_URL       postgres://... (required)
//   MIGRATIONS_FOLDER  defaults to ./drizzle (optional)
// It deliberately does NOT load lib/env.ts, so it never demands REDIS_URL,
// MFA_ENCRYPTION_KEY or any other application setting.
//
// Run it explicitly, once per deployment, before starting the new app
// version. Nothing runs it automatically (not the app, not the worker).
//
//   Production:  node scripts/migrate.mjs           (DATABASE_URL from the environment)
//   Development: npm run migrate                    (loads .env.local)
//
// Output never includes the connection string or its password.

import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

function fail(message) {
  console.error(`Migration aborted: ${message}`);
  process.exit(1);
}

function readConfig(env) {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) fail("DATABASE_URL is not set.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("DATABASE_URL is not a valid URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    fail("DATABASE_URL must be a postgres:// or postgresql:// URL.");
  }
  return {
    connectionString: raw,
    target: `${url.hostname}${url.pathname}`,
    migrationsFolder: resolve(env.MIGRATIONS_FOLDER?.trim() || "./drizzle"),
  };
}

const config = readConfig(process.env);
// Host and database only — never credentials.
console.log(`Running migrations against ${config.target} from ${config.migrationsFolder} ...`);

const pool = new pg.Pool({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
try {
  await migrate(drizzle(pool), { migrationsFolder: config.migrationsFolder });
  console.log("Migrations complete.");
} catch (err) {
  // Driver errors can echo connection details; print only the message, with any URL credentials masked.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Migration failed: ${message.replace(/\/\/[^@\s/]+@/g, "//***@")}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
