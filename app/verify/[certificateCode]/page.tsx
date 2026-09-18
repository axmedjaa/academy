import { headers } from "next/headers";
import { verifyCertificate } from "@/lib/academies/certificates";
import { AuthLogo } from "@/lib/ui/auth-components";
import { color, radius, spacing } from "@/lib/ui/theme";
import { VerifyLookupForm } from "../lookup-form";

/**
 * PLAN.md Phase 5, Item 62 — `/verify/[certificateCode]`. DESIGN.md §10:
 * "unauthenticated, no app chrome, no navigation. Shows only: student name,
 * program, issue date, valid/cancelled status." This route sits outside
 * every other layout in `app/` (root `app/layout.tsx` is bare html/body —
 * only `app/academy/layout.tsx` injects the authenticated `/academy/*`
 * chrome, and this route is nowhere under `/academy`), so it renders with
 * zero inherited navigation by construction; no route group is needed to
 * opt out of anything.
 *
 * ---------------------------------------------------------------------
 * Visual redesign (this wave) — Stitch reference vs. DESIGN.md conflict
 * ---------------------------------------------------------------------
 * `stitch_resource_file_manager/.../verify_certificate/code.html` is the
 * one Stitch mockup that exists for any public/auth route. It is used here
 * ONLY for its structural language (centered "Registry Lookup" input box,
 * an official-looking result panel with a status banner) — NOT verbatim:
 * that mockup (a) wraps the content in the full authenticated dashboard
 * sidebar/header shell, which directly contradicts DESIGN.md §10's "no app
 * chrome, no navigation" and is dropped entirely, and (b) invents a large
 * amount of fictional content (QR code, SHA-256 "ledger hash", cohort/grade
 * percentage, signatory names, Print/PDF/Share buttons) that has no backing
 * field anywhere in `verifyCertificate`'s real return type
 * (`PublicCertificateVerification`: studentName/programName/issuedAt/status
 * only). None of that fictional content is reproduced — DESIGN.md's exact,
 * minimal field list wins per this task's "DESIGN.md is authoritative on
 * conflict" rule. No print/PDF/download functionality is added, per this
 * task's explicit constraint.
 *
 * Server Component: reads `headers()` directly (no client-side fetch),
 * extracting the client IP the same way lib/auth/actions.ts's
 * `getClientIp` does (first `x-forwarded-for` entry), and passes both IP
 * and user-agent straight into `verifyCertificate`, which does its own
 * rate-limiting and lookup — this call and its inputs are completely
 * unchanged from before this restyle.
 *
 * Not-found and rate-limited both render a generic message and neither one
 * is styled or worded to look like a "yes, a certificate exists but..."
 * response — but per this item's brief they need not be identical to each
 * other (only real-vs-fake codes must be indistinguishable). A cancelled
 * certificate is never folded into either "not found" message — it renders
 * with its own explicit "Cancelled" status, per PLAN.md's explicit rule
 * that a cancelled certificate stays permanently, distinctly visible here.
 */
// Trusts the first `x-forwarded-for` entry as the client IP for rate
// limiting (see lib/academies/certificate-verify-rate-limit.ts). Production
// deployment assumes a trusted reverse proxy/load balancer sets (and
// overwrites, never appends to) this header — direct/untrusted access to
// this public route must not be allowed to reach it, or a caller could
// spoof this value to evade rate limiting.
function getClientIp(headerList: Awaited<ReturnType<typeof headers>>): string {
  return headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export default async function VerifyCertificatePage({
  params,
}: {
  params: Promise<{ certificateCode: string }>;
}) {
  const { certificateCode } = await params;
  const decodedCode = decodeURIComponent(certificateCode);
  const headerList = await headers();
  const ip = getClientIp(headerList);
  const userAgent = headerList.get("user-agent") ?? undefined;

  const result = await verifyCertificate(decodedCode, ip, userAgent);

  return (
    <div style={{ minHeight: "100vh", backgroundColor: color.bg, padding: `${spacing.xxl} ${spacing.md}` }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <AuthLogo />
        <div style={{ textAlign: "center", marginBottom: spacing.xl }}>
          <h1 style={{ margin: 0, fontSize: "1.6rem", color: color.text }}>Verify Certificate</h1>
          <p style={{ margin: 0, marginTop: spacing.xxs, fontSize: "0.9rem", color: color.textMuted }}>
            Enter a certificate code to check whether it was genuinely issued by this academy.
          </p>
        </div>

        <VerifyLookupForm initialCode={decodedCode} />

        <div style={{ marginTop: spacing.xl }}>
          {!result.ok ? (
            <div
              role="alert"
              style={{
                backgroundColor: color.card,
                border: `1px solid ${color.border}`,
                borderRadius: radius.card,
                boxShadow: "0 1px 3px 0 rgba(15, 23, 42, 0.06)",
                padding: spacing.lg,
                textAlign: "center",
                color: color.textMuted,
              }}
            >
              {result.error.code === "rate_limited"
                ? "Too many verification attempts from this location. Please try again later."
                : "No certificate was found for this code. Please check the code and try again."}
            </div>
          ) : (
            <VerificationResult
              studentName={result.certificate.studentName}
              programName={result.certificate.programName}
              issuedAt={result.certificate.issuedAt}
              status={result.certificate.status}
              certificateCode={decodedCode}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function VerificationResult({
  studentName,
  programName,
  issuedAt,
  status,
  certificateCode,
}: {
  studentName: string;
  programName: string;
  issuedAt: Date;
  status: "valid" | "cancelled";
  certificateCode: string;
}) {
  const isValid = status === "valid";
  const bannerBg = isValid ? color.statusGreenBg : color.statusSlateBg;
  const bannerFg = isValid ? color.statusGreen : color.statusSlate;

  return (
    <div
      style={{
        backgroundColor: color.card,
        border: `1px solid ${color.border}`,
        borderRadius: radius.card,
        boxShadow: "0 1px 3px 0 rgba(15, 23, 42, 0.06)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          backgroundColor: bannerBg,
          color: bannerFg,
          padding: spacing.md,
          display: "flex",
          alignItems: "center",
          gap: spacing.sm,
          fontWeight: 700,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            backgroundColor: bannerFg,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.9rem",
          }}
        >
          {isValid ? "✓" : "–"}
        </span>
        {isValid ? "Valid Certificate" : "Certificate Cancelled"}
      </div>

      <dl style={{ padding: spacing.lg, margin: 0, display: "flex", flexDirection: "column", gap: spacing.md }}>
        <div>
          <dt style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", color: color.textMuted }}>
            Student Name
          </dt>
          <dd style={{ margin: 0, marginTop: "0.2rem", fontSize: "1.1rem", fontWeight: 600, color: color.text }}>
            {studentName}
          </dd>
        </div>
        <div>
          <dt style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", color: color.textMuted }}>
            Program
          </dt>
          <dd style={{ margin: 0, marginTop: "0.2rem", fontSize: "1rem", color: color.text }}>{programName}</dd>
        </div>
        <div style={{ display: "flex", gap: spacing.xl }}>
          <div>
            <dt style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", color: color.textMuted }}>
              Issue Date
            </dt>
            <dd style={{ margin: 0, marginTop: "0.2rem", fontSize: "0.95rem", color: color.text }}>
              {formatDate(issuedAt)}
            </dd>
          </div>
          <div>
            <dt style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", color: color.textMuted }}>
              Certificate Code
            </dt>
            <dd style={{ margin: 0, marginTop: "0.2rem", fontSize: "0.85rem", fontFamily: "monospace", color: color.text }}>
              {certificateCode}
            </dd>
          </div>
        </div>
      </dl>
    </div>
  );
}
