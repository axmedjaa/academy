import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getCertificatePrintData } from "@/lib/academies/certificate-print";
import { PageMessage } from "@/app/academy/_shell/ui";
import { CertificatePrintView } from "./certificate-print-view";

/**
 * `/academy/certificates/[certificateId]/print` — the authenticated,
 * professionally-designed certificate view/print/PDF-export page. Distinct
 * from, and never modifying, the existing public `/verify/[certificateCode]`
 * route (DESIGN.md §10's minimal unauthenticated verification view stays
 * exactly as-is).
 *
 * Tenant isolation: `getCertificatePrintData` resolves `academyId` from
 * `actorContext` alone (via the existing, unmodified `getCertificate`) —
 * `certificateId` is the only thing this route takes from the URL, and it's
 * never trusted as belonging to the caller's academy until that lookup
 * confirms it; a certificate from a different academy (or a nonexistent
 * id) both return the identical generic `not_found`, same IDOR-safe
 * convention as every other `/academy/*` detail route in this codebase.
 * Anyone signed in with any view-capable role on this permission row
 * (Owner/Admin/Manager/Trainer — the exact same set `getCertificate`
 * already allows; Admissions/Finance Officer get `forbidden`) can reach
 * this page for their own academy's certificates — no new permission rule
 * was added or changed.
 */
export default async function CertificatePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ certificateId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { certificateId } = await params;
  const { autoprint } = await searchParams;
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const headerList = await headers();
  const protocol = headerList.get("x-forwarded-proto") ?? "http";
  const host = headerList.get("host");
  const requestOrigin = host ? `${protocol}://${host}` : undefined;

  const result = await getCertificatePrintData(context, certificateId, requestOrigin);
  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Certificate unavailable"}
        message={result.error.message}
      />
    );
  }

  return <CertificatePrintView certificateId={certificateId} data={result.data} autoPrint={autoprint === "1"} />;
}
