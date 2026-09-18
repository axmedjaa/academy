# npm audit findings (Phase 5, Item 64)

`npm audit` currently reports **4 moderate-severity vulnerabilities**, all
from the same chain: `esbuild` (bundled by `@esbuild-kit/core-utils` /
`@esbuild-kit/esm-loader`), pulled in transitively by `drizzle-kit`.

## Why this was not force-fixed

`npm audit fix --force` only offers a fix by installing `drizzle-kit@0.18.1`
— a **downgrade** from the currently installed `0.31.10` (already the
package's latest stable release; there is no newer version that resolves
this without downgrading). That would be a breaking change risking
compatibility with the 20+ migrations already generated under `0.31.x`'s
conventions, in exchange for closing a vulnerability that:

- only affects `esbuild`'s local development server accepting requests from
  arbitrary websites — a dev-tooling issue, not a production runtime one;
- never ships to production — `drizzle-kit` is a dev dependency used only
  for `npm run db:generate`/local migration authoring, not part of the
  deployed app.

Trading a real regression for a moderate, dev-only, non-production finding
was judged the wrong trade — so the dependency was **intentionally not
force-fixed**.

## Re-check trigger

Re-run `npm audit` whenever `drizzle-kit` (or its `esbuild` dependency) is
next upgraded — a future `drizzle-kit` release may pull in a patched
`esbuild` without requiring a downgrade, at which point this finding can be
closed normally.
