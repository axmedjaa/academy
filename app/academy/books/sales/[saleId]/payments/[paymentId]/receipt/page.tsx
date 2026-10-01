import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getBookSaleReceiptPrintData } from "@/lib/academies/book-sale-receipt-print";
import { PageMessage } from "@/app/academy/_shell/ui";
import { BookSalePaymentReceiptView } from "./book-sale-payment-receipt-view";

/**
 * `/academy/books/sales/[saleId]/payments/[paymentId]/receipt` — a
 * single-payment receipt, distinct from the overall sale receipt
 * (`/academy/books/sales/[saleId]/receipt`). Required so recording an
 * ADDITIONAL payment against an already-existing, already-partially-paid
 * sale gets its own receipt (§4 of this feature's own brief: "never claim
 * that the full amount was received") without fabricating a new sale.
 *
 * Reuses the same `getBookSaleReceiptPrintData` as the sale receipt (no
 * separate backend read path) — this page just picks out the one payment
 * matching `paymentId` from the already-computed, already-ordered
 * `payments` array (each entry already carries its own running total/
 * remaining, computed as of that payment — see that function's own module
 * comment). A `paymentId` that doesn't belong to this sale (wrong sale,
 * wrong academy, or simply doesn't exist) renders the same generic
 * "Receipt unavailable" as every other not-found case here — never a stack
 * trace or a different error shape that would leak which case applied.
 */
export default async function BookSalePaymentReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ saleId: string; paymentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { saleId, paymentId } = await params;
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

  const payment = result.data.payments.find((p) => p.id === paymentId);
  if (!payment) {
    return <PageMessage title="Receipt unavailable" message="This payment could not be found." />;
  }

  return <BookSalePaymentReceiptView data={result.data} payment={payment} autoPrint={autoprint === "1"} />;
}
