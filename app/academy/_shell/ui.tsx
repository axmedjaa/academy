import type { AnchorHTMLAttributes, CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { color, radius, shadow, spacing } from "@/lib/ui/theme";

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

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
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

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
      <span style={{ fontSize: "0.8rem", color: color.textMuted, fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: "1.6rem", fontWeight: 700, color: color.text }}>{value}</span>
      {hint && <span style={{ fontSize: "0.75rem", color: color.textMuted }}>{hint}</span>}
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

/** DESIGN.md §3.1 "Empty": line icon + one-line explanation + primary action. */
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: `${spacing.xxl} ${spacing.md}`,
        color: color.textMuted,
      }}
    >
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

/** DESIGN.md §3.1 "Loading": skeleton rows/cards matching the content shape. */
export function SkeletonBlock({ height = "1rem", width = "100%" }: { height?: string; width?: string }) {
  return (
    <div
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
        <h1 className="text-xl font-bold text-ink sm:text-2xl">{title}</h1>
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
 * pages built with class names rather than the `style` prop. */
export function Section({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-card border border-border bg-surface p-5 shadow-card ${className}`}>{children}</div>
  );
}

/** Search/filter bar row — wraps to multiple lines on narrow viewports
 * instead of overflowing or squashing controls. */
export function Toolbar({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mb-5 flex flex-wrap items-end gap-3 ${className}`}>{children}</div>;
}

const FIELD_LABEL = "block text-xs font-medium text-muted mb-1";
const FIELD_CONTROL =
  "block w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:cursor-not-allowed disabled:bg-app disabled:text-muted";

/** Class name for native `<input>`/`<select>`/`<textarea>` elements —
 * exported as a string (not a wrapping component) so existing
 * `useActionState` forms keep their native `name`/`defaultValue` wiring
 * unchanged and only gain a visible border, readable text, and a focus
 * ring. */
export const inputClass = FIELD_CONTROL;

/** Label + control wrapper. `children` is the native form control; this
 * only supplies the label text and consistent spacing. */
export function Field({
  label,
  htmlFor,
  className = "",
  children,
}: {
  label: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className={`block ${className}`}>
      <span className={FIELD_LABEL}>{label}</span>
      {children}
    </label>
  );
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-control px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const BUTTON_VARIANTS = {
  primary: `${BUTTON_BASE} bg-brand text-white hover:bg-brand-hover`,
  secondary: `${BUTTON_BASE} border border-border bg-surface text-ink hover:bg-app`,
  danger: `${BUTTON_BASE} border border-danger/30 bg-danger-bg text-danger hover:bg-danger/10`,
  /** Solid fill, reserved for PERMANENT deletion — deliberately louder than
   * the outlined `danger` variant (used by reversible actions like
   * Archive/Remove access) so a Delete button is never visually
   * confusable with one. */
  dangerSolid: `${BUTTON_BASE} bg-danger text-white hover:bg-danger/90`,
} as const;

type ButtonVariant = keyof typeof BUTTON_VARIANTS;

export function Button({
  variant = "primary",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button {...rest} className={`${BUTTON_VARIANTS[variant]} ${className}`} />;
}

/**
 * A permanently-disabled "Delete" row action, for entities PLAN.md's
 * Archive & Deactivation Rules table categorically requires to be
 * archived rather than deleted (Branches, Staff, Students, Courses,
 * Programs, Batches — see each entity's list component for the citation).
 * Uses the same `dangerSolid` variant a real Delete button would, so it
 * reads as "this is where Delete lives" rather than being missing
 * entirely, with a native tooltip explaining why it's inactive — per this
 * codebase's "show Delete disabled with a clear explanation" convention
 * rather than hiding the action outright.
 */
export function ProtectedDeleteButton({ entityLabel, className = "" }: { entityLabel: string; className?: string }) {
  return (
    <span
      title={`${entityLabel} records are kept permanently for history, audit, and reporting — deletion isn't available. Use Archive instead.`}
    >
      <Button type="button" variant="dangerSolid" className={`px-2.5 py-1 text-xs ${className}`} disabled>
        Delete
      </Button>
    </span>
  );
}

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
