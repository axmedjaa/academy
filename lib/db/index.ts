import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Performance pass — this module's top-level `new Pool()` used to run on
 * every single hot reload during `next dev`: each file edit re-evaluates
 * this module, and without a guard that mints a brand new connection pool
 * (default `max: 10`) each time, leaking every previous pool's connections
 * rather than reusing one. Against Neon specifically (a real, stricter
 * connection ceiling than a local Postgres, plus per-connection setup
 * latency on a cold compute) this is a direct, measurable cause of a dev
 * session getting slower the longer it runs, and can eventually surface as
 * literal "too many clients already" errors — the same well-documented
 * Next.js + node-postgres/Prisma pitfall, same standard fix: stash the pool
 * on `globalThis` (survives module re-evaluation; a fresh Node process on
 * every deploy still gets a clean pool) so a hot reload reuses the existing
 * pool instead of creating another. Also sets explicit `max`/timeouts
 * instead of node-postgres's defaults, since Neon's own connection limit is
 * finite and shared across whatever else is also connected to it. */
declare global {
  var __dbPool: Pool | undefined;
}

const pool =
  globalThis.__dbPool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__dbPool = pool;
}

export const db = drizzle(pool, { schema });

/**
 * The type of either `db` itself or the `tx` client inside `db.transaction()`
 * — both expose the same query-builder interface. Functions that must
 * participate in a caller's transaction (e.g. recordAudit(), per PLAN.md:
 * "the audit write happens in the same database transaction as the
 * mutation it protects") accept this type instead of importing `db` directly.
 */
export type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
