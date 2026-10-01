import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getBookSaleReceiptPrintData } from "@/lib/academies/book-sale-receipt-print";
import { PageMessage } from "@/app/academy/_shell/ui";
import { BookSaleReceiptView } from "./book-sale-receipt-view";

/**
 * `/academy/books/sales/[saleId]/receipt` — the Book Sales equivalent of
 * `/academy/receipts/[id]`: a viewable/printable document for the WHOLE
 * sale (final amount, every payment made against it, refunds, remaining
 * balance). Available immediately after a sale is recorded — no approval
 * step exists for book sales (see book-sale-receipt-print.ts's module
 * comment), so there is nothing to wait on.
 *
 * Tenant isolation: `getBookSaleReceiptPrintData` resolves `academyId` from
 * `actorContext` alone (via the existing, unmodified `getBookSale`) — a
 * sale id from a different academy returns the identical generic
 * `not_found`, same IDOR-safe convention as `/academy/receipts/[id]`.
 */
export default async function BookSaleReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ saleId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { saleId } = await params;
  const { autoprint } = await searchParams;
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const result = await getBookSaleReceiptPrintData(context, saleId);
  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Receipt unavailable"}
        message={result.error.message}
      />
    );
  }

  return <BookSaleReceiptView data={result.data} autoPrint={autoprint === "1"} />;
}
