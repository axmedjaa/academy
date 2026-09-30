import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getReceiptPrintData } from "@/lib/academies/receipt-print";
import { PageMessage } from "@/app/academy/_shell/ui";
import { ReceiptPrintView } from "./receipt-print-view";

/**
 * `/academy/receipts/[id]` — the authenticated, viewable/printable receipt
 * page (PDF verification report §9). Distinct from the receipt *number*
 * shown inline in payment history — this is the actual document a staff
 * member (or the student, handed a printout) can read: student, academy,
 * payment amount/method/date, receipt number, reference, notes, and who
 * recorded it.
 *
 * Tenant isolation: `getReceiptPrintData` resolves `academyId` from
 * `actorContext` alone (via the existing, unmodified `getReceipt`) —
 * `id` is the only thing this route takes from the URL, and it's never
 * trusted as belonging to the caller's academy until that lookup confirms
 * it; a receipt from a different academy (or a nonexistent id) both return
 * the identical generic `not_found`, same IDOR-safe convention as every
 * other `/academy/*` detail route in this codebase (see
 * app/academy/certificates/[certificateId]/print/page.tsx's identical
 * comment).
 */
export default async function ReceiptPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { autoprint } = await searchParams;
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const result = await getReceiptPrintData(context, id);
  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Receipt unavailable"}
        message={result.error.message}
      />
    );
  }

  return <ReceiptPrintView data={result.data} autoPrint={autoprint === "1"} />;
}
