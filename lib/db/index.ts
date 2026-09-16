import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema });

/**
 * The type of either `db` itself or the `tx` client inside `db.transaction()`
 * — both expose the same query-builder interface. Functions that must
 * participate in a caller's transaction (e.g. recordAudit(), per PLAN.md:
 * "the audit write happens in the same database transaction as the
 * mutation it protects") accept this type instead of importing `db` directly.
 */
export type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
