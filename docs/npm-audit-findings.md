# npm audit findings

Last reviewed during the security audit (Priority 3 — dependency
findings). Supersedes the Phase 5/Item 64 version of this document, which
only covered the `drizzle-kit`/`esbuild` chain below and predates the
Next.js and `eslint-config-next` findings.

## Fixed in this review

- **`next` 16.3.5 → 16.4.0** (critical RCE in `next/og` `ImageResponse`,
  plus cross-user cache poisoning/content substitution, SSRF in Image
  Optimization, dev-server MCP info disclosure, metadata image
  `dynamicParams` bypass — 7 advisories total, 1 critical + 6 high). A
  same-minor-track patch release, not a breaking major bump. This app
  doesn't use `next/og`/`ImageResponse` or `next/image` (confirmed by
  grep — every image renders as a plain `<img>` from an R2 signed URL),
  which narrowed live exposure but didn't eliminate it; the framework's
  own routes exist regardless of whether app code calls into them.
- **`sharp` → 0.35.5, `source-map-js` → 1.2.2** (both high-severity, both
  via plain `npm audit fix`, no `--force`, no major bump). `sharp` is
  `next`'s own optional transitive dependency (image optimization,
  unused here per above); `source-map-js` is pulled in by Tailwind's
  PostCSS pipeline and Vite/Vitest — build-time tooling only.

Verified after both: `tsc --noEmit`, full-project `eslint`, the entire
`lib/auth/` test suite, and `next build` all pass clean on the upgraded
versions.

## Remaining: 9 vulnerabilities (4 moderate, 5 high), both dev-tooling-only chains

### `drizzle-kit` → transitive `esbuild` (4 moderate)

`esbuild` (bundled by `@esbuild-kit/core-utils` / `@esbuild-kit/esm-loader`),
pulled in transitively by `drizzle-kit`. The only fix `npm audit fix
--force` offers is `drizzle-kit@0.18.1` — a **downgrade** from the
currently installed `0.31.10` (already latest stable; no newer version
resolves this without downgrading). Not applied:

- the advisory is specifically "esbuild's local dev server accepts
  requests from arbitrary websites" — a dev-tooling issue with no
  production-runtime surface;
- `drizzle-kit` never ships to production — confirmed by reading
  `scripts/migrate.ts`: migrations are *applied* via
  `drizzle-orm/node-postgres/migrator` reading plain `.sql` files,
  entirely independent of `drizzle-kit`. `drizzle-kit` itself is used
  only for `npm run db:generate` (local migration authoring);
- downgrading would risk compatibility with the 30+ migrations already
  generated under `0.31.x`'s conventions, for a dev-only, non-production
  finding — the wrong trade.

### `eslint-config-next` → transitive `braces`/`micromatch`/`fast-glob`/`@next/eslint-plugin-next` (5 high)

Surfaced only after the `next` 16.4.0 upgrade pulled in a newer transitive
chain through `eslint-config-next`. The only fix is
`eslint-config-next@14.2.35` — a **major downgrade** from whatever version
pairs with `next@16.x` today, flagged by npm itself as
`isSemVerMajor: true`. Not applied:

- the underlying advisory (`braces` stack-exhaustion DoS, GHSA-vfj7-8cjw-p6xm)
  is reachable only through `@next/eslint-plugin-next`'s own file-globbing
  during `npm run lint` — ESLint is a dev-time CLI tool, never imported by
  the running Next.js server or bundled into any client/server output;
- downgrading `eslint-config-next` to a `14.x` release alongside
  `next@16.4.0` risks lint-rule/compat breakage for no production security
  benefit.

## Re-check trigger

Re-run `npm audit` whenever `drizzle-kit` or `eslint-config-next` is next
upgraded — either one may eventually ship a release that pulls in a
patched version of its respective chain without requiring a downgrade, at
which point that finding can be closed normally.
