import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
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

/**
 * Perf investigation (Afoogy slow-dashboard task, Neon-connection step):
 * node-postgres's own docs/issue tracker (https://github.com/brianc/node-postgres/issues/1700)
 * are explicit that an idle pooled client is still a live socket — if its
 * backend connection dies (Neon's free-tier compute auto-suspends after 5
 * minutes idle, per Neon's own connection-latency docs, and drops every
 * connection open at that moment) the client emits its own 'error' event.
 * With no listener anywhere on the Pool, node-postgres re-emits that as the
 * Pool's own 'error' event; Node treats an EventEmitter 'error' with zero
 * listeners as fatal and throws it as an uncaught exception.
 *
 * This is the exact, repeated `⨯ uncaughtException: Error: Connection
 * terminated unexpectedly` seen in .dev-server.log (35 occurrences, several
 * in back-to-back bursts matching this pool's own `max: 10` right after an
 * idle gap) — not a query-execution bottleneck, a missing required
 * listener. The same `lib/db` module is imported by Vitest's integration
 * tests against this same Neon database, so the identical gap is also a
 * plausible cause of a test *process* dying mid-suite before its own
 * `afterAll` cleanup runs — one route to the leaked test-fixture rows
 * found in the test-isolation step of this investigation.
 *
 * The fix is exactly what node-postgres's own maintainers recommend on that
 * issue: attach a listener so the error is logged and the dead client is
 * dropped, instead of propagating. This is not a retry/keep-alive policy —
 * Postgres's `pg.Pool` already removes an errored client from its internal
 * set on its own; the only gap was that nothing was listening.
 */
pool.on("error", (err) => {
  logger.error("Postgres pool client error", { error: err.message });
});

export const db = drizzle(pool, { schema });

/**
 * The type of either `db` itself or the `tx` client inside `db.transaction()`
 * — both expose the same query-builder interface. Functions that must
 * participate in a caller's transaction (e.g. recordAudit(), per PLAN.md:
 * "the audit write happens in the same database transaction as the
 * mutation it protects") accept this type instead of importing `db` directly.
 */
export type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
