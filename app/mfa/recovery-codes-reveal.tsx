"use client";

import { useState } from "react";

interface Props {
  recoveryCodes: string[];
  onContinue: () => void;
}

/**
 * Shared by /mfa/setup (Item 13) and /mfa/recovery-codes (Item 15) — DESIGN.md
 * §7: regenerating recovery codes gets "the same one-time reveal as setup."
 */
export function RecoveryCodesReveal({ recoveryCodes, onContinue }: Props) {
  const [saved, setSaved] = useState(false);

  return (
    <div>
      <p role="alert" style={{ fontWeight: "bold" }}>
        Save these now — they will not be shown again.
      </p>
      <ul style={{ fontFamily: "monospace" }}>
        {recoveryCodes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <label style={{ display: "block", margin: "1rem 0" }}>
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />{" "}
        I&apos;ve saved these recovery codes
      </label>
      <button type="button" disabled={!saved} onClick={onContinue}>
        Continue
      </button>
    </div>
  );
}
