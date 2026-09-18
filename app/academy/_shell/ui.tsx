import type { CSSProperties, ReactNode } from "react";
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
