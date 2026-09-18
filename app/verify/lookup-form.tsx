"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PrimaryButton } from "@/lib/ui/auth-components";
import { color, radius, spacing } from "@/lib/ui/theme";

/**
 * Stitch's `verify_certificate/code.html` frames this route as a "Registry
 * Lookup" with an input + "Verify Certificate" button rather than a
 * bare result page — this small client component adds that same
 * interaction on top of the existing `/verify/[certificateCode]` dynamic
 * route, without changing how verification itself works: submitting just
 * navigates to `/verify/<code>`, which the existing Server Component
 * (page.tsx) still renders exactly as before (same `verifyCertificate`
 * call, same rate limiting, same generic not-found handling). No new
 * backend call is made here.
 */
export function VerifyLookupForm({ initialCode = "" }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode);
  const router = useRouter();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed) {
      router.push(`/verify/${encodeURIComponent(trimmed)}`);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        gap: spacing.sm,
        flexWrap: "wrap",
        backgroundColor: color.card,
        border: `1px solid ${color.border}`,
        borderRadius: radius.card,
        padding: spacing.md,
        boxShadow: "0 1px 3px 0 rgba(15, 23, 42, 0.06)",
      }}
    >
      <input
        type="text"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="Enter certificate code, e.g. AB3D-7HKL-9MNP-Q2ST"
        aria-label="Certificate code"
        style={{
          flex: 1,
          minWidth: 220,
          padding: "0.65rem 0.85rem",
          fontSize: "0.95rem",
          border: `1px solid ${color.border}`,
          borderRadius: radius.control,
          color: color.text,
          textTransform: "uppercase",
          letterSpacing: "0.03em",
        }}
      />
      <PrimaryButton type="submit" style={{ width: "auto", padding: "0.65rem 1.5rem" }}>
        Verify Certificate
      </PrimaryButton>
    </form>
  );
}
