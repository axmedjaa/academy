import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { academies, books, students } from "@/lib/db/schema";
import { getBookSale, type BookSaleActionError } from "@/lib/academies/book-sales";
import { getAcademyLogoUrl } from "@/lib/academies/academy-logo";
import { resolveStaffLabels } from "@/lib/academies/staff-labels";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Book Sale receipt print data — the Book Sales equivalent of
 * lib/academies/receipt-print.ts's `getReceiptPrintData`, built the same
 * way (a new, additive read layer over an existing, unmodified getter —
 * here `getBookSale`, which already resolves tenant isolation, permission,
 * and the full payment/refund history in one call).
 *
 * ---------------------------------------------------------------------
 * Why this does NOT reuse the `receipts` table / `issueReceipt`
 * ---------------------------------------------------------------------
 * `receipts` is hard-wired to `student_payments` (a NOT NULL
 * `studentPaymentId` FK) and `issueReceipt` requires the target payment's
 * `status` to already be `"approved"` — book sales have no approval
 * workflow at all (§46-47 of the original design: posts directly), so
 * neither the schema shape nor the "approved" precondition applies. Adding
 * a migration to make that FK polymorphic, just to get a persisted receipt
 * row for a domain that never needed approval gating, would be schema
 * complexity this feature doesn't need. Instead, the receipt "number" is
 * derived deterministically from the sale's own id (`BS-<id8>`), with each
 * payment numbered by its chronological position within that sale
 * (`BS-<id8> · Payment 2 of 3`) — stable, unique enough for a printed
 * document, and requires zero schema changes.
 *
 * ---------------------------------------------------------------------
 * Running totals — never claim more was received than actually was
 * ---------------------------------------------------------------------
 * Each payment's `runningTotalPaidCents`/`remainingAfterCents` is computed
 * from payments ordered by (`paidAt`, `createdAt`) up to AND INCLUDING that
 * payment — so a receipt printed for payment #2 always shows the totals as
 * they stood once payment #2 was recorded, even if a payment #3 is added
 * later and this exact receipt URL is revisited. This is what lets "Never
 * claim that $100 was received" hold even after the fact.
 */

export interface BookSaleReceiptPayment {
  id: string;
  amountCents: number;
  method: "cash" | "mobile_money";
  reference: string | null;
  paidAt: Date;
  recordedByLabel: string;
  /** This payment's 1-based position among the sale's payments, ordered by
   * paidAt then createdAt — e.g. "Payment 2 of 3". */
  ordinal: number;
  /** Sum of every payment up to and including this one. */
  runningTotalPaidCents: number;
  /** finalAmountCents - runningTotalPaidCents, floored at 0. */
  remainingAfterCents: number;
}

export interface BookSaleReceiptPrintData {
  sale: {
    id: string;
    /** Deterministic, display-only identifier — see this file's module
     * comment for why it's not a persisted sequential number. */
    receiptNumber: string;
    saleDate: Date;
    quantity: number;
    unitPriceCents: number;
    currency: string;
    subtotalCents: number;
    discountType: "none" | "fixed" | "percentage";
    discountValue: number;
    discountAmountCents: number;
    finalAmountCents: number;
    totalPaidCents: number;
    totalRefundedCents: number;
    netPaidCents: number;
    remainingCents: number;
    paymentStatus: "unpaid" | "partially_paid" | "paid";
  };
  academy: {
    name: string;
    logoUrl: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    registrationNumber: string | null;
  };
  book: { name: string; isbn: string | null };
  buyer:
    | { type: "student"; studentName: string; studentNumber: string | null; phone: string | null }
    | { type: "other_person"; name: string; phone: string | null };
  recordedByLabel: string;
  payments: BookSaleReceiptPayment[];
  /** Server-computed at fetch time — never `new Date()` inside the client
   * view's render, which would risk an SSR/hydration mismatch. */
  generatedAt: Date;
}

export type GetBookSaleReceiptPrintDataResult =
  | { ok: true; data: BookSaleReceiptPrintData }
  | { ok: false; error: BookSaleActionError };

function receiptNumberFor(saleId: string): string {
  return `BS-${saleId.slice(0, 8).toUpperCase()}`;
}

export async function getBookSaleReceiptPrintData(
  actorContext: AuthContext,
  bookSaleId: string,
): Promise<GetBookSaleReceiptPrintDataResult> {
  const saleResult = await getBookSale(actorContext, bookSaleId);
  if (!saleResult.ok) return saleResult;
  const { sale } = saleResult;

  const [academyRow] = await db
    .select({
      name: academies.name,
      logoRef: academies.logoRef,
      address: academies.address,
      phone: academies.phone,
      email: academies.email,
      website: academies.website,
      registrationNumber: academies.registrationNumber,
    })
    .from(academies)
    .where(eq(academies.id, sale.academyId))
    .limit(1);

  const [bookRow] = await db
    .select({ isbn: books.isbn })
    .from(books)
    .where(and(eq(books.id, sale.bookId), eq(books.academyId, sale.academyId)))
    .limit(1);

  let buyer: BookSaleReceiptPrintData["buyer"];
  if (sale.buyerType === "student" && sale.studentId) {
    const [studentRow] = await db
      .select({ fullName: students.fullName, studentNumber: students.studentNumber, phone: students.phone })
      .from(students)
      .where(and(eq(students.id, sale.studentId), eq(students.academyId, sale.academyId)))
      .limit(1);
    buyer = {
      type: "student",
      studentName: studentRow?.fullName ?? sale.studentName ?? "Unknown student",
      studentNumber: studentRow?.studentNumber ?? null,
      phone: studentRow?.phone ?? null,
    };
  } else {
    buyer = { type: "other_person", name: sale.otherBuyerName ?? "Other person", phone: sale.otherBuyerPhone };
  }

  const sortedPayments = [...sale.payments].sort(
    (a, b) => a.paidAt.getTime() - b.paidAt.getTime() || a.id.localeCompare(b.id),
  );
  const recordedByIds = [sale.recordedBy, ...sortedPayments.map((p) => p.recordedBy)];
  const labels = await resolveStaffLabels(sale.academyId, recordedByIds);

  let runningTotal = 0;
  const payments: BookSaleReceiptPayment[] = sortedPayments.map((payment, index) => {
    runningTotal += payment.amountCents;
    return {
      id: payment.id,
      amountCents: payment.amountCents,
      method: payment.method,
      reference: payment.reference,
      paidAt: payment.paidAt,
      recordedByLabel: labels.get(payment.recordedBy) ?? payment.recordedBy,
      ordinal: index + 1,
      runningTotalPaidCents: runningTotal,
      remainingAfterCents: Math.max(0, sale.finalAmountCents - runningTotal),
    };
  });

  return {
    ok: true,
    data: {
      sale: {
        id: sale.id,
        receiptNumber: receiptNumberFor(sale.id),
        saleDate: sale.createdAt,
        quantity: sale.quantity,
        unitPriceCents: sale.unitPriceCents,
        currency: sale.currency,
        subtotalCents: sale.subtotalCents,
        discountType: sale.discountType,
        discountValue: sale.discountValue,
        discountAmountCents: sale.discountAmountCents,
        finalAmountCents: sale.finalAmountCents,
        totalPaidCents: sale.totalPaidCents,
        totalRefundedCents: sale.totalRefundedCents,
        netPaidCents: sale.netPaidCents,
        remainingCents: sale.remainingCents,
        paymentStatus: sale.paymentStatus,
      },
      academy: {
        name: academyRow?.name ?? "Academy",
        logoUrl: academyRow?.logoRef ? await getAcademyLogoUrl(academyRow.logoRef) : null,
        address: academyRow?.address ?? null,
        phone: academyRow?.phone ?? null,
        email: academyRow?.email ?? null,
        website: academyRow?.website ?? null,
        registrationNumber: academyRow?.registrationNumber ?? null,
      },
      book: { name: sale.bookName, isbn: bookRow?.isbn ?? null },
      buyer,
      recordedByLabel: labels.get(sale.recordedBy) ?? sale.recordedBy,
      payments,
      generatedAt: new Date(),
    },
  };
}
