# Accepted dependency advisories

This file records `npm audit` findings that are deliberately **not** fixed,
why, and when to revisit them. Anything not listed here should be fixed.

Last reviewed: 2026-10-22 (after `fix: patch Vitest and Vite dev-dependency
advisories`).

## Current state

| Check | Result |
|---|---|
| `npm audit --omit=dev` (what ships with the app) | 0 findings |
| `npm audit` (including dev tooling) | 9 findings: 5 high, 4 moderate, 0 critical — all covered below |

Both accepted chains are **development tooling only**: neither package is
part of the production server bundle, and neither is reachable from a
request to the running app.

## 1. esbuild 0.18.20 under drizzle-kit — accepted

- **Advisory:** [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)
  (moderate). esbuild `<= 0.24.2`; fixed in `0.25.0`.
- **Flagged packages (one chain):** `drizzle-kit` (direct dev dependency)
  → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild@0.18.20`.
- **What the advisory affects:** only esbuild's `serve` development server,
  which sends `Access-Control-Allow-Origin: *` so any website can read the
  files it serves.
- **Why it doesn't apply here (verified 2026-10-22):**
  `@esbuild-kit/core-utils` only calls `esbuild.transform` /
  `transformSync`, the in-memory TypeScript transform `drizzle-kit` uses to
  load `drizzle.config.ts`. Nothing in that chain calls `serve`. The
  project's only use of `drizzle-kit` is `npm run db:generate`, a local
  command. Every other esbuild in the tree (via `tsx`, `vite` and
  `drizzle-kit` itself) is already `>= 0.25`.
- **Why not fixed:** the latest stable `drizzle-kit` (0.31.11) still depends
  on the deprecated `@esbuild-kit/esm-loader`, which pins `esbuild ~0.18.20`.
  `npm audit fix --force` would *downgrade* `drizzle-kit` to 0.18.1, which is
  much older and not appropriate. Forcing esbuild `^0.25` through `overrides`
  skips seven minor versions behind a pinned range and is not worth the
  migration-tool risk for an unreachable code path.
- **Revisit when:** a stable `drizzle-kit` release no longer depends on
  `@esbuild-kit/*` (1.0 is still a release candidate), or the advisory is
  extended to `transform`. Check with `npm ls esbuild` after upgrading
  `drizzle-kit`.

## 2. braces 3.0.3 under eslint-config-next — accepted (no patch exists)

- **Advisory:** [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
  (high, CVSS 8.7, availability only). `braces <= 3.0.3`; **no patched
  version has been published** (3.0.3 is the latest release).
- **Flagged packages (one chain):** `eslint-config-next` (direct dev
  dependency) → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` →
  `braces`.
- **What the advisory affects:** a deeply nested brace *pattern* exhausts the
  call stack and crashes the process. The attacker has to control the glob
  pattern.
- **Why it doesn't apply here (verified 2026-10-22):** this is the only path
  to `braces` in the tree (`npm ls braces`). `@next/eslint-plugin-next` uses
  `fast-glob` in exactly one place (`dist/utils/get-root-dirs.js`), to expand
  `settings.next.rootDir` from the ESLint config. `eslint.config.mjs` does
  not set `rootDir`, so the plugin falls back to the working directory and
  never calls `fast-glob` at all. The patterns are never user input, and
  lint runs only on developer machines and CI.
- **Why not fixed:** nothing to upgrade to. `npm audit fix --force` would
  downgrade `eslint-config-next` to 14.2.35, which doesn't match Next.js 16.
- **Revisit when:** `braces` (or `micromatch` / `fast-glob`) publishes a fix,
  or `eslint-config-next` stops depending on `fast-glob`. Then update
  `eslint-config-next`, or add an npm `overrides` entry for the fixed
  version if upstream lags. Also revisit if anyone adds
  `settings.next.rootDir` to the lint config from a non-literal source.

## How to re-check

```sh
npm audit --omit=dev          # must stay at 0 findings
npm audit                     # should list only the two chains above
npm ls esbuild braces         # confirms the dependency paths described here
```

Any new finding, or any change to the paths above, needs fixing or a new
entry in this file.
