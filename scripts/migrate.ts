// Kept for existing callers (CI runs `node --import=tsx scripts/migrate.ts`).
// The runner itself is scripts/migrate.mjs: plain Node, only DATABASE_URL
// required, no tsx needed in production. See that file.
import "./migrate.mjs";
