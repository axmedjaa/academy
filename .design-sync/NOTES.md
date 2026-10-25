# design-sync notes — academy-management-saas / Dardar School System

## Repo shape

This is a Next.js app, not a standalone component-library package: no
`.storybook/`, no `*.stories.*`, no `dist/` build, no `main`/`types` in
`package.json`. The design system lives inside the app as plain source:
`app/academy/_shell/ui.tsx` (shared primitives), `app/academy/_shell/icons.tsx`
(icon set + `BrandMark`), and `components/ui/*` (shadcn/Radix-derived
`alert-dialog`, `dropdown-menu`, `pagination`, `sonner`). `lib/ui/theme.ts` +
`app/globals.css` hold the design tokens (Tailwind v4 `@theme` block).

Per the user's explicit scope, only these five files/dirs are synced. Route
pages, business logic, DB/auth/server actions, and generated files are
excluded — the sync never touched application source to make itself work.

## Synth-entry setup (no dist/ exists)

- `cfg.entry` points at `.design-sync/.cache/ds-entry.tsx`, a synthetic entry
  I authored that does `export * from` the five scoped files. This is NOT
  app source — it only exists to feed the converter.
- `cfg.componentSrcMap` explicitly pins every one of the 59 component names
  to its real source file, because the converter's default `srcDir`
  auto-discovery (`src/` | `lib/` | `components/`, first match) picks `lib/`
  in this repo (business-logic code, zero components) and never looks at
  `app/academy/_shell/` or `components/ui/`. Without the explicit map the
  build reports `[ZERO_MATCH]`.
- `cfg.cssEntry` points at `.design-sync/.cache/compiled-globals.css`, which
  `.design-sync/.cache/compile-css.mjs` generates by running the repo's real
  `@tailwindcss/postcss` pipeline against `app/globals.css` (there is no
  pre-compiled CSS file anywhere in the repo — Tailwind v4 compiles at
  request time via Next's own build, not a committed artifact). **Re-run
  `node .design-sync/.cache/compile-css.mjs` before any re-sync** if
  `app/globals.css` or any Tailwind class usage in the scoped files changed —
  the converter does not do this automatically.

## next/link shim (real fix, not a workaround to delete later)

`app/academy/_shell/ui.tsx` imports `next/link` (used by `Card`'s
link-wrapped variant, `Breadcrumbs`, `BackLink`, `LinkButton`). Next's
compiled `next/link` module references several `process.env.__NEXT_*` flags
at module-eval time (router basepath, trailing-slash, manual-client-base-path,
link-no-touch-start, i18n flags) that only exist inside a real Next.js build.
Outside Next (esbuild's browser bundle, no Next runtime) these throw
`ReferenceError: process is not defined` for the WHOLE bundle — not just the
components that use Link — because the bundle is one IIFE and any top-level
throw during its evaluation leaves `window.DardarDS` empty (confirmed: first
build attempt showed `[BUNDLE_EXPORT] 59/59 not a component on
window.DardarDS`, all with the identical ReferenceError).

Fix: `.design-sync/.cache/shims/next-link.tsx` is a minimal `forwardRef`
component rendering a plain `<a href>` — the same DOM output `next/link`
produces, since this is what it already was once the router-prefetch
behavior (never exercised in a static preview) is set aside. Wired in via
`cfg.tsconfig` pointing at `.design-sync/.cache/ds-tsconfig.json`, which
copies the real `tsconfig.json`'s `@/*` path mapping and adds one more path:
`"next/link": ["./.design-sync/.cache/shims/next-link.tsx"]`. This only
affects the design-sync bundle — the real app's `tsconfig.json` and
`ui.tsx` are untouched, and the real app still uses real `next/link` with
full router integration.

**This is load-bearing, not optional.** If a future re-sync's build fails
with `ReferenceError: process is not defined` across every component, check
that `cfg.tsconfig` still points at `ds-tsconfig.json` (not the repo's own
`tsconfig.json`) and that the shim file still exists.

## Known render warns (confirmed benign, not new issues on a re-sync)

- `[RENDER_THIN] BrandMark` — "mounts have no text and paint nothing".
  `BrandMark` is a pure SVG logo mark with no text content by design; the
  thin-check's text heuristic doesn't apply to icon-only components.
  Screenshot confirmed: renders the burgundy rounded badge + white
  cube-outline + gold accent dot correctly (`ds-bundle/_screenshots/
  shell__BrandMark.png`, `pngBytes: 7212`, `blank: false`, `bad: false`).
- `[RENDER_THIN] Icon` — same cause, same confirmation (renders 4 burgundy
  icons correctly, `pngBytes: 8146`, `blank: false`, `bad: false`).
- `[FONT_MISSING] Cambria` — Tailwind v4's own default `--font-serif`
  fallback stack (`ui-serif, Georgia, Cambria, "Times New Roman", Times,
  serif`), included in `app/globals.css`'s compiled output by default. No
  component in this app sets `font-serif` or renders text in a serif
  family — confirmed by grep. Not an actionable gap.
- `tokens: 209 defined, 139 referenced (2 missing, below threshold)` — below
  the validator's own failure threshold, not investigated further.

## Preview-authoring scope (user's explicit choice)

User chose "author the ~15 blank ones" over "author all 59" or "floor
cards everywhere." 17 components needed authoring (render-check flagged more
than the 15 estimated once actually measured): `AlertDialogFooter`,
`DropdownMenuLabel`, `DropdownMenuSeparator`, `PaginationEllipsis`,
`PaginationItem`, `PaginationLink`, `BackLink`, `Badge`, `BrandMark`,
`EmptyState`, `Field`, `Icon`, `PageHeader`, `SkeletonBlock`, `TableWrap`,
`Toolbar`, `UsageBar`. All 17 are authored and graded good. The remaining 42
components ship on the floor card — this was the user's deliberate choice,
not a shortfall; they can be authored incrementally on any future re-sync
without redoing today's work (today's grades and the uploaded `_ds_sync.json`
carry forward).

Three components got `cfg.overrides.<Name>: {"cardMode": "single",
"viewport": "..."}` because their real behavior only exists in an open
overlay state: `AlertDialogFooter`, `DropdownMenuLabel`,
`DropdownMenuSeparator` — each preview renders the full parent
(`AlertDialog`/`DropdownMenu`) with `open` forced true, per the skill's
"leaf that throws outside its provider → full parent composition" rule.

## guidelinesGlob

`cfg.guidelinesGlob` is set to `[]`. The converter's default
(`docs/guides/**/*.md`, `docs/*.md`, `guides/**/*.md`, relative to the
repo-root `PKG_DIR`) picked up three unrelated operational docs
(`docs/backup-restore-drill.md`, `docs/npm-audit-findings.md`,
`docs/release-checklist.md`) that have nothing to do with the design
system — this repo's `docs/` is for engineering ops, not design guidelines.
There is no real design-guidelines doc in scope today; if one is added
later, point `guidelinesGlob` at it explicitly rather than re-enabling the
default globs.

## Re-sync risks

- **`compiled-globals.css` is a generated artifact, not committed source of
  truth.** If a re-sync runs without first re-running
  `node .design-sync/.cache/compile-css.mjs`, the bundle ships whatever
  stale CSS happens to be on disk in `.design-sync/.cache/` — it is
  gitignored, so a fresh clone has none and the build will fail at
  `[CSS_IMPORT_MISSING]` until it's regenerated once.
- **The `next/link` shim is a structural dependency of the build, not a
  one-time patch** — see above. A future person touching `cfg.tsconfig` to
  "fix" it back to the repo's real `tsconfig.json` will silently reintroduce
  the whole-bundle crash.
- **`componentSrcMap` is hand-maintained, not auto-discovered**, because this
  repo's layout doesn't match the converter's `srcDir` heuristic. Adding a
  new component to any of the 5 scoped files requires a matching
  `componentSrcMap` entry, or it won't appear in the DS project at all (no
  warning is printed for a component that exists in the file but isn't
  listed).
- Only 5 files/dirs are in scope by explicit user instruction
  (`app/academy/_shell/ui.tsx`, `app/academy/_shell/icons.tsx`,
  `components/ui/*`, `lib/ui/theme.ts`, `app/globals.css`). If the user later
  wants the rest of the app's screens/pages represented, that's a scope
  change to discuss, not something to infer from this file.
