import { headers } from "next/headers";
import { verifyCertificate } from "@/lib/academies/certificates";

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
 * Server Component: reads `headers()` directly (no client-side fetch),
 * extracting the client IP the same way lib/auth/actions.ts's
 * `getClientIp` does (first `x-forwarded-for` entry), and passes both IP
 * and user-agent straight into `verifyCertificate`, which does its own
 * rate-limiting and lookup. This page never queries the database itself —
 * every field it can possibly render is already limited to whatever
 * `verifyCertificate`'s `PublicCertificateVerification` type exposes
 * (studentName/programName/issuedAt/status), so there is no separate
 * leakage surface to audit here beyond that function's own.
 *
 * Not-found and rate-limited both render a generic message and neither one
 * is styled or worded to look like a "yes, a certificate exists but..."
 * response — but per this item's brief they need not be identical to each
 * other (only real-vs-fake codes must be indistinguishable). A cancelled
 * certificate is never folded into either "not found" message — it renders
 * with its own explicit "Cancelled" status, per PLAN.md's explicit rule
 * that a cancelled certificate stays permanently, distinctly visible here.
 */
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

const PAGE_STYLE = {
  maxWidth: 480,
  margin: "4rem auto",
  padding: "0 1rem",
  fontFamily: "system-ui, sans-serif",
} as const;

export default async function VerifyCertificatePage({
  params,
}: {
  params: Promise<{ certificateCode: string }>;
}) {
  const { certificateCode } = await params;
  const headerList = await headers();
  const ip = getClientIp(headerList);
  const userAgent = headerList.get("user-agent") ?? undefined;

  const result = await verifyCertificate(decodeURIComponent(certificateCode), ip, userAgent);

  if (!result.ok) {
    const message =
      result.error.code === "rate_limited"
        ? "Too many verification attempts from this location. Please try again later."
        : "No certificate was found for this code. Please check the code and try again.";
    return (
      <main style={PAGE_STYLE}>
        <h1>Certificate Verification</h1>
        <p role="alert">{message}</p>
      </main>
    );
  }

  const { certificate } = result;
  const isValid = certificate.status === "valid";

  return (
    <main style={PAGE_STYLE}>
      <h1>Certificate Verification</h1>
      <p
        style={{
          display: "inline-block",
          padding: "0.25rem 0.75rem",
          borderRadius: 999,
          fontWeight: 600,
          color: isValid ? "#075e2a" : "#7a1717",
          backgroundColor: isValid ? "#e3f6e8" : "#fbe6e6",
        }}
      >
        {isValid ? "Valid" : "Cancelled"}
      </p>
      <dl>
        <dt style={{ fontWeight: 600, marginTop: "1rem" }}>Student Name</dt>
        <dd style={{ margin: 0 }}>{certificate.studentName}</dd>

        <dt style={{ fontWeight: 600, marginTop: "1rem" }}>Program</dt>
        <dd style={{ margin: 0 }}>{certificate.programName}</dd>

        <dt style={{ fontWeight: 600, marginTop: "1rem" }}>Issue Date</dt>
        <dd style={{ margin: 0 }}>{formatDate(certificate.issuedAt)}</dd>
      </dl>
    </main>
  );
}
