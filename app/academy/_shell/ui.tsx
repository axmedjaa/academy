import { forwardRef, type AnchorHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { color, radius, shadow, spacing } from "@/lib/ui/theme";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

/**
 * Small set of shared presentational primitives for `/academy/*` screens
 * built in this wave (dashboard, certificates, id-cards) — the codebase has
 * no existing component library (confirmed by grep before this file was
 * added: no `components/ui/`, no Tailwind), and every prior page just
 * inlines its own `style={{}}` objects. Rather than repeating near-identical
 * card/badge/empty-state markup across four new files, this collects the
 * handful actually reused across them. Deliberately not a general design
 * system — DESIGN.md §3's fuller component catalogue (data table, stepper,
 * approval queue, ...) is out of scope here; only what Phases B–D need.
 */

export function Card({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        backgroundColor: color.card,
        border: `1px solid ${color.border}`,
        borderRadius: radius.card,
        boxShadow: shadow.card,
        padding: spacing.lg,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * `index`, when passed, staggers this card's entrance slightly behind the
 * ones before it (a KPI row appearing as a short cascade rather than all at
 * once) — purely cosmetic, defaults to 0 (no delay) for any caller that
 * doesn't pass it. `motion-safe:` means the animation never applies under
 * `prefers-reduced-motion: reduce`; those users simply see the finished
 * state immediately, with full functionality unaffected either way.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  index = 0,
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: ReactNode;
  index?: number;
  /** When provided, the whole card becomes a link to the stat's own module
   * (e.g. "Total Students" -> /academy/students) — optional and additive;
   * every existing call site that omits it keeps rendering as a plain,
   * non-interactive card exactly as before. */
  href?: string;
}) {
  const content = (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "0.8rem", color: color.textMuted, fontWeight: 500 }}>{label}</span>
        {icon && <span style={{ color: color.textMuted, display: "flex" }}>{icon}</span>}
      </div>
      <span
        style={{
          fontSize: "1.75rem",
          fontWeight: 700,
          color: color.text,
          letterSpacing: "-0.01em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
      {hint && <span style={{ fontSize: "0.75rem", color: color.textMuted }}>{hint}</span>}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="motion-safe:animate-fade-in-up motion-safe:active:scale-[0.98] transition-shadow hover:shadow-md"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: spacing.xs,
          animationDelay: `${index * 60}ms`,
          backgroundColor: color.card,
          border: `1px solid ${color.border}`,
          borderRadius: radius.card,
          boxShadow: shadow.card,
          padding: spacing.lg,
          textDecoration: "none",
        }}
      >
        {content}
      </Link>
    );
  }

  return (
    <Card
      className="motion-safe:animate-fade-in-up"
      style={{ display: "flex", flexDirection: "column", gap: spacing.xs, animationDelay: `${index * 60}ms` }}
    >
      {content}
    </Card>
  );
}

const BADGE_TONES = {
  gray: { bg: color.statusGrayBg, fg: color.statusGray },
  amber: { bg: color.statusAmberBg, fg: color.statusAmber },
  green: { bg: color.statusGreenBg, fg: color.statusGreen },
  red: { bg: color.statusRedBg, fg: color.statusRed },
  blue: { bg: color.statusBlueBg, fg: color.statusBlue },
  slate: { bg: color.statusSlateBg, fg: color.statusSlate },
} as const;

/** DESIGN.md §3 "Status badge" — one component, color + label always paired
 * (never color alone, per the §1 accessibility floor). */
export function StatusBadge({ label, tone }: { label: string; tone: keyof typeof BADGE_TONES }) {
  const { bg, fg } = BADGE_TONES[tone];
  return (
    <span
      style={{
        display: "inline-block",
        backgroundColor: bg,
        color: fg,
        borderRadius: 999,
        padding: "0.15rem 0.6rem",
        fontSize: "0.75rem",
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

/** DESIGN.md §3.1 "Empty": optional icon + one-line explanation + primary
 * action (shown only when the caller has permission to act — see each call
 * site). `icon` is optional and additive; existing callers that don't pass
 * one keep the exact same plain-text layout as before. */
export function EmptyState({
  message,
  action,
  icon,
}: {
  message: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: `${spacing.xxl} ${spacing.md}`,
        color: color.textMuted,
      }}
    >
      {icon && (
        <div
          style={{
            margin: `0 auto ${spacing.sm}`,
            width: 44,
            height: 44,
            borderRadius: "50%",
            backgroundColor: color.statusGrayBg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: color.textMuted,
          }}
        >
          {icon}
        </div>
      )}
      <p style={{ margin: 0, marginBottom: action ? spacing.sm : 0 }}>{message}</p>
      {action}
    </div>
  );
}

/** DESIGN.md §3.1 "Error": specific inline message; used for both a failed
 * server-action result and a permission-denied section. */
export function ErrorMessage({ message }: { message: string }) {
  return (
    <p
      role="alert"
      style={{
        color: color.statusRed,
        backgroundColor: color.statusRedBg,
        border: `1px solid ${color.statusRed}33`,
        borderRadius: radius.control,
        padding: `${spacing.xs} ${spacing.sm}`,
        fontSize: "0.85rem",
      }}
    >
      {message}
    </p>
  );
}

export function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { style, ...rest } = props;
  return (
    <button
      {...rest}
      style={{
        backgroundColor: color.primaryBlue,
        color: "#fff",
        border: "none",
        borderRadius: radius.control,
        padding: "0.55rem 1rem",
        fontSize: "0.9rem",
        fontWeight: 600,
        cursor: rest.disabled ? "not-allowed" : "pointer",
        opacity: rest.disabled ? 0.6 : 1,
        ...style,
      }}
    />
  );
}

export function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { style, ...rest } = props;
  return (
    <button
      {...rest}
      style={{
        backgroundColor: color.card,
        color: color.text,
        border: `1px solid ${color.border}`,
        borderRadius: radius.control,
        padding: "0.55rem 1rem",
        fontSize: "0.9rem",
        fontWeight: 500,
        cursor: rest.disabled ? "not-allowed" : "pointer",
        opacity: rest.disabled ? 0.6 : 1,
        ...style,
      }}
    />
  );
}

/** DESIGN.md §3.1 "Loading": skeleton rows/cards matching the content shape.
 * `animate-pulse` (Tailwind's built-in opacity pulse) signals "in progress"
 * instead of sitting as an inert flat block; `motion-reduce:animate-none`
 * keeps it a static placeholder for anyone who has asked for reduced
 * motion. */
export function SkeletonBlock({ height = "1rem", width = "100%" }: { height?: string; width?: string }) {
  return (
    <div
      className="animate-pulse motion-reduce:animate-none"
      style={{
        height,
        width,
        borderRadius: radius.control,
        backgroundColor: color.statusGrayBg,
      }}
    />
  );
}

/**
 * --- Tailwind-based primitives (UI quality pass) ---------------------------
 *
 * The components/constants above predate Tailwind and are left as-is (they
 * already look fine and back already-restyled pages: Dashboard, Finance,
 * Certificates, ID cards). Everything below targets the previously
 * plain/legacy `/academy/*` pages (Students, Staff, Courses, Batches,
 * Programs, Timetable, Exams, Results, Grades, Admissions, Branches) being
 * brought up to the same visual bar with Tailwind utility classes instead of
 * ad hoc inline styles. Same brand tokens either way — see app/globals.css's
 * `@theme` block, which mirrors lib/ui/theme.ts.
 */

export const PAGE_WRAP = "mx-auto w-full max-w-6xl px-4 py-8 sm:px-6";

/** A trail of ancestor links ending at the current page (no href on the
 * last entry, rendered as plain text). Added for the one genuinely 3-deep
 * route in the app (Book Sales -> Sale Receipt -> Payment Receipt) — most
 * pages are 1-2 levels deep and use the existing "<- Back to X" link
 * convention instead, which this does not replace. */
export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
      {items.map((item, index) => (
        <span key={index} className="flex items-center gap-1.5">
          {index > 0 && <span aria-hidden="true">›</span>}
          {item.href ? (
            <Link href={item.href} className="hover:underline hover:text-ink">
              {item.label}
            </Link>
          ) : (
            <span className="text-ink font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** Page title + optional description + right-aligned actions. Wraps to a
 * stacked layout on narrow screens instead of squeezing the action button. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Replaces the repeated raw `<main><h1>Access denied</h1><p>...</p></main>`
 * blocks scattered across `/academy/*` pages with a readable, bordered
 * message card instead of unstyled black-on-white text. */
export function PageMessage({ title, message }: { title: string; message: string }) {
  return (
    <div className={PAGE_WRAP}>
      <div className="rounded-card border border-border bg-surface p-6 shadow-card">
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        <p className="mt-1 text-sm text-muted">{message}</p>
      </div>
    </div>
  );
}

/** Bordered content section — the Tailwind equivalent of `Card` above, for
 * pages built with class names rather than the `style` prop. Pass
 * `interactive` only for a section that is itself a click target (e.g.
 * wrapped in a `<Link>`/`<button>`) — it adds a subtle hover elevation so
 * the affordance is visible; a plain static content section should never
 * set this, since a hover-shadow on something unclickable is misleading. */
export function Section({
  children,
  className = "",
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <div
      className={`rounded-card border border-border bg-surface p-5 shadow-card ${
        interactive ? "transition-shadow duration-150 hover:shadow-card-hover" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** Search/filter bar row — wraps to multiple lines on narrow viewports
 * instead of overflowing or squashing controls. */
export function Toolbar({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mb-5 flex flex-wrap items-end gap-3 ${className}`}>{children}</div>;
}

const FIELD_LABEL = "block text-xs font-medium text-muted mb-1";
const FIELD_CONTROL =
  "block w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink transition-colors duration-150 placeholder:text-muted/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:cursor-not-allowed disabled:bg-app disabled:text-muted";

/** Class name for native `<input>`/`<select>`/`<textarea>` elements —
 * exported as a string (not a wrapping component) so existing
 * `useActionState` forms keep their native `name`/`defaultValue` wiring
 * unchanged and only gain a visible border, readable text, and a focus
 * ring. */
export const inputClass = FIELD_CONTROL;

/** Label + control wrapper. `children` is the native form control; this
 * only supplies the label text and consistent spacing. `error`, when
 * present, renders an inline red message below the control — additive and
 * optional (existing callers that never pass it are unaffected), for forms
 * using lib/validation/use-field-errors.ts's client-side pre-submit
 * validation. */
export function Field({
  label,
  htmlFor,
  className = "",
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  className?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className={`block ${className}`}>
      <span className={FIELD_LABEL}>{label}</span>
      {children}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-control px-4 py-2 text-sm font-semibold transition-colors duration-150 motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100";
const BUTTON_VARIANTS = {
  primary: `${BUTTON_BASE} bg-brand text-white hover:bg-brand-hover`,
  secondary: `${BUTTON_BASE} border border-border bg-surface text-ink hover:bg-app`,
  /** Lighter-weight than `secondary` — border only, no filled background at
   * rest. For a page's second-most-important action where a bordered white
   * button would visually compete with `secondary` elsewhere on the same
   * screen. */
  outline: `${BUTTON_BASE} border border-border-strong bg-transparent text-ink hover:bg-app`,
  /** No border, no background at rest — the lowest-emphasis action (e.g. a
   * "Cancel" next to a dialog's primary/destructive button, or a repeated
   * row-level action where a full bordered button would be too heavy). */
  ghost: `${BUTTON_BASE} text-ink hover:bg-app`,
  danger: `${BUTTON_BASE} border border-danger/30 bg-danger-bg text-danger hover:bg-danger/10`,
  /** Solid fill, reserved for PERMANENT deletion — deliberately louder than
   * the outlined `danger` variant (used by reversible actions like
   * Archive/Remove access) so a Delete button is never visually
   * confusable with one. */
  dangerSolid: `${BUTTON_BASE} bg-danger text-white hover:bg-danger/90`,
} as const;

type ButtonVariant = keyof typeof BUTTON_VARIANTS;

/**
 * `forwardRef` (added for the shadcn `AlertDialog` integration —
 * `components/ui/confirm-dialog.tsx` renders this as the child of an
 * `asChild` Radix trigger/action/cancel, which clones its child and injects
 * a ref; a plain function component would only warn, not actually break,
 * but forwarding it properly is what lets Radix track the real trigger/
 * action DOM node for its own focus-management) — every existing call site
 * (a plain `<Button ...>`) is unaffected, since a forwardRef component is
 * used in JSX exactly the same way as a function component.
 */
export const Button = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }>(
  function Button({ variant = "primary", className = "", ...rest }, ref) {
    return <button ref={ref} {...rest} className={`${BUTTON_VARIANTS[variant]} ${className}`} />;
  },
);

/** Same visual treatment as `Button`, for navigation actions that must be a
 * `<Link>` (e.g. "Add student") rather than a form submit. */
export function LinkButton({
  variant = "primary",
  className = "",
  href,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; href: string }) {
  return <Link href={href} {...rest} className={`${BUTTON_VARIANTS[variant]} ${className}`} />;
}

/** Badge tone classes matching lib/ui/theme.ts's status palette, for pages
 * using Tailwind class names instead of the `StatusBadge` component above. */
const BADGE_TONE_CLASS = {
  gray: "bg-app text-muted",
  amber: "bg-warning-bg text-warning",
  green: "bg-success-bg text-success",
  red: "bg-danger-bg text-danger",
  blue: "bg-info-bg text-info",
  slate: "bg-slate-bg text-slate",
} as const;

export function Badge({ label, tone }: { label: string; tone: keyof typeof BADGE_TONE_CLASS }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE_TONE_CLASS[tone]}`}>
      {label}
    </span>
  );
}

/** Horizontally-scrolling table wrapper so wide tables degrade gracefully on
 * small screens instead of breaking the page layout. */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>
    </div>
  );
}

export const th = "border-b border-border bg-app px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted";
export const td = "border-b border-border px-4 py-3 text-ink";
export const trHover = "hover:bg-app/60";

/** DESIGN.md §3 "Usage/allowance bar": label + "used / limit" + a thin
 * progress bar, green under 80%, amber 80-99%, red at/over 100% — reused
 * wherever a page needs a compact capacity indicator for one resource.
 * Settings' own full usage table (academy-usage-widget.tsx) renders a
 * richer per-resource table with its own inline bar for a different,
 * denser view — this is the compact, single-row version for a quick
 * summary (e.g. a dashboard), not a replacement for that table. */
export function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const barColorClass = ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "bg-success";
  return (
    <div>
      <div className="flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="tabular-nums">
          {used} / {limit}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-app">
        <div
          className={`h-1.5 rounded-full transition-[width] duration-300 ${barColorClass}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

/** Shape-matched loading-skeleton building block — `animate-pulse` is
 * Tailwind's built-in utility; `motion-reduce:animate-none` keeps it a
 * static placeholder under `prefers-reduced-motion: reduce`. Previously
 * duplicated locally in app/academy/dashboard/loading.tsx and
 * app/academy/students/loading.tsx (each page's own shape differs enough
 * to still hand-roll its own skeleton markup there); exported here so the
 * simpler "header + plain table" pages below can share both this and
 * `ListPageSkeleton` instead of re-declaring it a third+ time. */
export function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

/**
 * Shape-matched skeleton for the common "PageHeader + plain data table"
 * page shape (Admissions, Staff, Branches, Programs, Courses, Batches, ...)
 * — none of these had a `loading.tsx` before this pass, so the page
 * visibly popped from blank to fully loaded. Not for Dashboard/Students,
 * whose own composition (stat grid, merged filter+table surface) is
 * different enough to keep their own hand-written skeletons.
 * `columns` controls how many `<th>`/`<td>` skeletons render per row —
 * callers pass the same count their real table renders so nothing
 * reflows once data arrives; `firstColumnWide` widens just the first
 * column's cell pulses, for tables whose first column is an identity
 * cell (a name) rather than a short value. */
export function ListPageSkeleton({
  columns,
  rows = 6,
  firstColumnWide = true,
}: {
  columns: number;
  rows?: number;
  firstColumnWide?: boolean;
}) {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-32" />
        <Pulse className="h-4 w-72" />
      </div>
      <TableWrap>
        <thead>
          <tr>
            {Array.from({ length: columns }).map((_, index) => (
              <th key={index} className={th}>
                <Pulse className="h-3 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: columns }).map((_, colIndex) => (
                <td key={colIndex} className={td}>
                  <Pulse className={colIndex === 0 && firstColumnWide ? "h-3.5 w-32" : "h-3.5 w-16"} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}

/**
 * Shared centered-dialog shell for "edit this record" forms that were
 * previously rendered as a permanent inline section below a table
 * (Branches, Courses). Wraps the existing `AlertDialog` primitives
 * (components/ui/alert-dialog.tsx) rather than hand-rolling a new dialog —
 * `AlertDialogContent` already centers itself, caps at `max-h-[85vh]` with
 * internal scrolling, and animates in via the app's existing
 * `animate-scale-in`/`animate-fade-in` keyframes, so this only needs to add
 * the title and a slightly wider max-width suited to multi-field forms.
 * Callers keep owning their own form markup/Cancel+Save buttons as
 * `children`; closing on successful submit is the caller's
 * responsibility (call `onOpenChange(false)` once the action state is ok). */
export function FormDialog({
  open,
  onOpenChange,
  title,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  /** Overrides the default `max-w-lg` — e.g. `max-w-xl` for a form with
   * several side-by-side field grids that feel cramped at the default
   * width (see app/platform/plans/plans-manager.tsx's Edit Plan dialog).
   * Merged via `cn`'s `twMerge`, so passing a `max-w-*` class here wins
   * over the default rather than conflicting with it. */
  className?: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={cn("max-w-lg", className)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        {children}
      </AlertDialogContent>
    </AlertDialog>
  );
}
