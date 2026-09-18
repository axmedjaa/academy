"use client";

import { useState } from "react";
import { PrimaryButton } from "@/lib/ui/auth-components";
import { color, radius, spacing } from "@/lib/ui/theme";

interface Props {
  recoveryCodes: string[];
  onContinue: () => void;
}

/**
 * Shared by /mfa/setup (Item 13) and /mfa/recovery-codes (Item 15) — DESIGN.md
 * §7: regenerating recovery codes gets "the same one-time reveal as setup."
 * Pure restyle — the underlying "you must tick the box before Continue is
 * enabled" behavior is unchanged.
 */
export function RecoveryCodesReveal({ recoveryCodes, onContinue }: Props) {
  const [saved, setSaved] = useState(false);

  return (
    <div>
      <p
        role="alert"
        style={{
          margin: 0,
          fontWeight: 700,
          color: color.statusAmber,
          backgroundColor: color.statusAmberBg,
          border: `1px solid ${color.statusAmber}33`,
          borderRadius: radius.control,
          padding: `${spacing.sm} ${spacing.sm}`,
          fontSize: "0.9rem",
        }}
      >
        Save these now — they will not be shown again.
      </p>
      <ul
        style={{
          fontFamily: "monospace",
          fontSize: "0.9rem",
          backgroundColor: color.bg,
          border: `1px solid ${color.border}`,
          borderRadius: radius.control,
          padding: `${spacing.sm} ${spacing.xl}`,
          margin: `${spacing.md} 0`,
        }}
      >
        {recoveryCodes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: `${spacing.md} 0`, fontSize: "0.9rem", color: color.text }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I&apos;ve saved these recovery codes
      </label>
      <PrimaryButton type="button" disabled={!saved} onClick={onContinue}>
        Continue
      </PrimaryButton>
    </div>
  );
}
