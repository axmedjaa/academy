import type { CSSProperties, ReactNode } from "react";
import { color, radius, shadow, spacing } from "@/lib/ui/theme";

/**
 * Shared presentational primitives for the public/unauthenticated and
 * account-security screens (`/login`, `/forgot-password`, `/reset-password`,
 * `/mfa/*`, `/account/security`, `/verify/[certificateCode]`).
 *
 * Deliberately separate from `app/academy/_shell/ui.tsx` — these routes are
 * not part of the authenticated `/academy/*` console (no sidebar, no
 * academy/branch context, sometimes not even a signed-in user at all), so
 * this file has zero dependency on anything under `app/academy/`. It reuses
 * the same underlying design tokens (`lib/ui/theme.ts`, itself derived from
 * DESIGN.md §1) so the two areas of the product still look like one system,
 * without either one importing from the other.
 *
 * No Stitch reference exists for any of these screens (confirmed by
 * exhaustive grep across stitch_resource_file_manager/ before this file was
 * written — the Stitch export only ever designs the already-authenticated
 * console). DESIGN.md §7's "Pattern C (modal-style centered card)" is the
 * only spec these primitives follow.
 */

export function AuthShell({ children, maxWidth = 420 }: { children: ReactNode; maxWidth?: number }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: color.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: spacing.xl,
      }}
    >
      <div style={{ width: "100%", maxWidth }}>{children}</div>
    </div>
  );
}

/** Small brand mark, adapted from the Stitch export's own
 * `afoogy_logo/code.html` asset (a rounded-square monogram + wordmark) —
 * inline SVG, no image request, no new dependency. */
export function AuthLogo() {
  return (
    <div style={{ display: "flex", justifyContent: "center", marginBottom: spacing.lg }}>
      <svg width="140" height="34" viewBox="0 0 240 60" fill="none" role="img" aria-label="Afoogy">
        <rect x="6" y="10" width="40" height="40" rx="10" fill={color.primaryBlue} />
        <path
          d="M26 18L37 26V38L26 42L15 38V26L26 18Z"
          stroke="#FFFFFF"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path d="M26 27V42M26 27L37 26M26 27L15 26" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
        <circle cx="26" cy="18" r="2.5" fill="#93C5FD" />
        <text x="58" y="38" fontFamily="Inter, -apple-system, sans-serif" fontSize="24" fontWeight="700" fill={color.text} letterSpacing="-0.5">
          Afoogy
        </text>
      </svg>
    </div>
  );
}

/** DESIGN.md §7 Pattern C: "modal-style centered card." Used for every
 * auth form screen (login, forgot/reset password, MFA setup/challenge). */
export function AuthCard({
  title,
  subtitle,
  children,
  maxWidth = 400,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  maxWidth?: number;
}) {
  return (
    <AuthShell maxWidth={maxWidth}>
      <AuthLogo />
      <div
        style={{
          backgroundColor: color.card,
          border: `1px solid ${color.border}`,
          borderRadius: radius.card,
          boxShadow: shadow.card,
          padding: spacing.xl,
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.4rem", color: color.text, textAlign: "center" }}>{title}</h1>
        {subtitle && (
          <p style={{ margin: 0, marginTop: spacing.xxs, fontSize: "0.85rem", color: color.textMuted, textAlign: "center" }}>
            {subtitle}
          </p>
        )}
        <div style={{ marginTop: spacing.lg }}>{children}</div>
      </div>
    </AuthShell>
  );
}

export const fieldLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  fontSize: "0.85rem",
  fontWeight: 500,
  color: color.text,
};

export const fieldInputStyle: CSSProperties = {
  width: "100%",
  padding: "0.6rem 0.75rem",
  fontSize: "0.95rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.control,
  color: color.text,
  fontFamily: "inherit",
};

export const formColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: spacing.md,
};

export function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { style, ...rest } = props;
  return (
    <button
      {...rest}
      style={{
        width: "100%",
        backgroundColor: color.primaryBlue,
        color: "#fff",
        border: "none",
        borderRadius: radius.control,
        padding: "0.65rem 1rem",
        fontSize: "0.95rem",
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
        padding: "0.5rem 0.9rem",
        fontSize: "0.85rem",
        fontWeight: 500,
        cursor: rest.disabled ? "not-allowed" : "pointer",
        opacity: rest.disabled ? 0.6 : 1,
        ...style,
      }}
    />
  );
}

/** Plain content card — used by /account/security (DESIGN.md §7 Pattern B),
 * the one screen in this file's scope that isn't a centered auth form. */
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

/** "This device" / status tag — DESIGN.md §3 Status badge component. */
export function Pill({ label, tone = "blue" }: { label: string; tone?: "blue" | "gray" }) {
  const bg = tone === "blue" ? color.statusBlueBg : color.statusGrayBg;
  const fg = tone === "blue" ? color.statusBlue : color.statusGray;
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

export function AuthLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { style, ...rest } = props;
  return <a {...rest} style={{ color: color.primaryBlue, fontSize: "0.85rem", textDecoration: "none", ...style }} />;
}

/** Generic credential/validation error (red) — DESIGN.md §11.8: "Invalid
 * email or password." never distinguishes whether the email exists. */
export function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      style={{
        margin: 0,
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

/** DESIGN.md §7: "Lockout state after repeated failures (rate-limited
 * server-side)" — deliberately distinct (amber, not red) from a plain
 * invalid-credentials/validation error, so a rate-limited response never
 * reads as "your password is wrong." */
export function LockoutBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      style={{
        margin: 0,
        color: color.statusAmber,
        backgroundColor: color.statusAmberBg,
        border: `1px solid ${color.statusAmber}33`,
        borderRadius: radius.control,
        padding: `${spacing.xs} ${spacing.sm}`,
        fontSize: "0.85rem",
      }}
    >
      {message}
    </p>
  );
}

export function SuccessBanner({ message }: { message: string }) {
  return (
    <p
      role="status"
      style={{
        margin: 0,
        color: color.statusGreen,
        backgroundColor: color.statusGreenBg,
        border: `1px solid ${color.statusGreen}33`,
        borderRadius: radius.control,
        padding: `${spacing.xs} ${spacing.sm}`,
        fontSize: "0.85rem",
      }}
    >
      {message}
    </p>
  );
}

/** Render whichever banner fits an action-state error's `code` — every
 * auth action in lib/auth/*.ts uses `"RATE_LIMITED"` for its lockout case,
 * so this one helper covers login/forgot-password/reset-password/MFA
 * setup/challenge identically without each page re-deriving the mapping. */
export function AuthErrorBanner({ code, message }: { code: string; message: string }) {
  if (code === "RATE_LIMITED") {
    return <LockoutBanner message={message} />;
  }
  return <ErrorBanner message={message} />;
}
