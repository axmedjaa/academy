// Bundles scripts/worker.ts (and the application code it imports, resolved
// through tsconfig "@/..." paths) into dist/worker.mjs, so production runs
// the worker with plain `node` — no tsx or TypeScript at runtime.
// npm packages stay external and load from node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/worker.ts"],
  outfile: "dist/worker.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  tsconfig: "tsconfig.json",
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});
