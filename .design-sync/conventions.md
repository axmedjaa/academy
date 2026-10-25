## Dardar School System — design-system conventions

**Brand**: single primary hue, burgundy (`--color-brand: #850019`), not a
navy+blue pair. Gold (`--color-accent-gold: #f5b638`) is a sparing accent
only — **never** a background behind white/light text, and **never** small
text color on a light surface (fails contrast). Pair gold with dark ink
(`#111827`) text, or use it only on the dark burgundy surface.

### Wrapping and setup

No root provider is required for basic rendering — components read colors
from CSS custom properties and Tailwind utility classes, not React context.
Overlay components (`AlertDialog`, `DropdownMenu`) are self-contained Radix
primitives; force them open with the `open` prop to show their content state
(see `AlertDialogFooter`/`DropdownMenuLabel`/`DropdownMenuSeparator`
previews for the full-parent-composition pattern — a leaf like
`AlertDialogFooter` only renders meaningfully inside its full
`AlertDialog`/`AlertDialogContent` tree).

**Known gap**: the brand typeface (Alexandria, body; JetBrains Mono,
technical identifiers) is loaded via `next/font/google` in the app's root
layout, which is outside this sync's scope (route/layout files are
excluded). `--font-sans`/`--font-mono` are real tokens but currently
resolve to their system-font fallback chain in this bundle, not the actual
webfonts. Build layouts assuming Alexandria's proportions/weights, but
expect the live render here to show a system sans-serif until the fonts are
wired in a future sync.

### Styling idiom

Tailwind v4 utility classes generated from real `@theme` tokens in
`app/globals.css` — use these names, not invented ones:

| Need | Classes |
|---|---|
| Brand action/link/active-nav | `bg-brand`, `text-brand`, `hover:bg-brand-hover`, `bg-brand-tint` (selected/active background) |
| Dark chrome (Platform shell sidebar, dialog overlay scrim) | `bg-navy` (same burgundy value as `bg-brand` — one brand hue, two historical names) |
| Surfaces/text | `bg-app` (page bg), `bg-surface` (card/sidebar/input), `text-ink` (primary text), `text-muted` (secondary) |
| Borders | `border-border`, `border-border-strong` |
| Radius | `rounded-control` (8px, inputs/buttons), `rounded-card` (12px, cards/modals) |
| Elevation | `shadow-card`, `shadow-card-hover` |
| Status (preserve exactly — never reuse for brand emphasis) | `bg-success`/`text-success`/`bg-success-bg`, same pattern for `warning`/`danger`/`info`, plus `slate` (closed/archived, deliberately duller) |

Gold has no generated utility class yet (nothing in the scoped files uses
`bg-accent-gold`/`text-accent-gold` as a literal class today) — use the raw
custom property `var(--color-accent-gold)` in an inline style, the same way
`BrandMark`'s accent dot and the `IdCardVisual` accent border do.

Components outside `components/ui/*` (the shared primitives in
`app/academy/_shell/ui.tsx`/`icons.tsx`) mix Tailwind classes with inline
`style={{}}` objects sourced from `lib/ui/theme.ts`'s `color`/`spacing`/
`radius`/`shadow` constants — both are real, both ship in this bundle;
match whichever pattern the specific component you're extending already
uses.

### Where the truth lives

`styles.css` (imports `_ds_bundle.css`, the real compiled Tailwind output)
and each component's own `.d.ts`/`.prompt.md`. Read the shipped `.d.ts` for
exact prop names — several components here are the app's own shadcn/Radix
forks (`components/ui/*`), not the upstream shadcn defaults.

### Example

```tsx
<PageHeader
  title="Students"
  description="All students enrolled across every branch."
  actions={<Button variant="primary">Add student</Button>}
/>
```
