import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { academies, studentCharges, studentPayments, students } from "@/lib/db/schema";
import { getReceipt, type StudentPaymentsActionError } from "@/lib/academies/student-payments";
import { listFeePeriodPaymentHistory } from "@/lib/academies/fee-periods";
import { resolveStaffLabels } from "@/lib/academies/staff-labels";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Authenticated receipt view/print data — a NEW, additive read layer on top
 * of the existing, unmodified `getReceipt` (lib/academies/student-payments.ts),
 * same shape as certificate-print.ts's relationship to `getCertificate`.
 *
 * ---------------------------------------------------------------------
 * Tenant isolation — the whole security story lives in one reused call
 * ---------------------------------------------------------------------
 * `getReceipt(actorContext, receiptId)` (unchanged) resolves `academyId`
 * from `actorContext` alone and filters `eq(receipts.academyId, academyId)`
 * — a receiptId belonging to a different academy already returns the
 * identical generic `not_found` any nonexistent id would. Every further
 * lookup below (`payment`/`student`/`charge`/`academy`) is additionally
 * scoped to that SAME `receipt.academyId`, never a client-supplied one, so
 * this module inherits tenant isolation rather than re-implementing it.
 *
 * `getReceipt` uses `resolveStudentPaymentsAccess`'s "view-or-above" gate —
 * the same set of roles that can already see a payment in payment history
 * (Owner/Admin/Manager/Finance Officer/Trainer) can view/print its receipt;
 * this file adds no new permission rule.
 *
 * The "Fee period(s) / Charge" description below re-derives from
 * `listFeePeriodPaymentHistory`, which is gated on the separate
 * `academy.fee_periods` permission row — if the caller lacks that (e.g. a
 * hypothetical future role with student_payments view but not fee_periods
 * view), the receipt still renders fully, just without the period
 * breakdown (falls back to a generic description), same graceful
 * per-section degradation used throughout this codebase.
 */
export interface ReceiptPrintData {
  receipt: { id: string; receiptNumber: string; issuedAt: Date };
  academy: {
    name: string;
    logoRef: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    registrationNumber: string | null;
  };
  student: { fullName: string; studentNumber: string };
  payment: {
    amountCents: number;
    currency: string;
    method: "cash" | "mobile_money" | "bank_transfer";
    reference: string | null;
    notes: string | null;
    receivedAt: Date;
    status: "pending_approval" | "approved" | "rejected" | "reversed";
  };
  /** "Course — Batch: period, period" for a fee-period payment, "Charge:
   * description" for a one-off charge payment, "—" for neither (or if the
   * caller lacks fee_periods view access). */
  description: string;
  recordedByLabel: string;
}

export type GetReceiptPrintDataResult =
  | { ok: true; data: ReceiptPrintData }
  | { ok: false; error: StudentPaymentsActionError };

export async function getReceiptPrintData(
  actorContext: AuthContext,
  receiptId: string,
): Promise<GetReceiptPrintDataResult> {
  const receiptResult = await getReceipt(actorContext, receiptId);
  if (!receiptResult.ok) return receiptResult;
  const { receipt } = receiptResult;

  const [paymentRow] = await db
    .select()
    .from(studentPayments)
    .where(and(eq(studentPayments.id, receipt.studentPaymentId), eq(studentPayments.academyId, receipt.academyId)))
    .limit(1);
  if (!paymentRow) {
    // Unreachable in practice (a receipt's studentPaymentId is a NOT NULL FK
    // populated at issueReceipt time and payments are never hard-deleted) —
    // defensive only, same generic error shape as every other not_found here.
    return { ok: false, error: { code: "not_found", message: "The payment for this receipt could not be found." } };
  }

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
    .where(eq(academies.id, receipt.academyId))
    .limit(1);

  const [studentRow] = await db
    .select({ fullName: students.fullName, studentNumber: students.studentNumber })
    .from(students)
    .where(and(eq(students.id, paymentRow.studentId), eq(students.academyId, receipt.academyId)))
    .limit(1);

  let description = "—";
  if (paymentRow.chargeId) {
    const [chargeRow] = await db
      .select({ description: studentCharges.description })
      .from(studentCharges)
      .where(and(eq(studentCharges.id, paymentRow.chargeId), eq(studentCharges.academyId, receipt.academyId)))
      .limit(1);
    if (chargeRow) description = `Charge: ${chargeRow.description}`;
  } else {
    const historyResult = await listFeePeriodPaymentHistory(actorContext, { studentId: paymentRow.studentId });
    if (historyResult.ok) {
      const entry = historyResult.rows.find((row) => row.paymentId === paymentRow.id);
      if (entry) {
        description = `${entry.courseName} — ${entry.batchName}: ${entry.periods
          .map((period) => `${period.periodStart} – ${period.periodEnd}`)
          .join(", ")}`;
      }
    }
  }

  const recorderLabels = await resolveStaffLabels(receipt.academyId, [paymentRow.recordedBy]);

  return {
    ok: true,
    data: {
      receipt: { id: receipt.id, receiptNumber: receipt.receiptNumber, issuedAt: receipt.issuedAt },
      academy: {
        name: academyRow?.name ?? "Academy",
        logoRef: academyRow?.logoRef ?? null,
        address: academyRow?.address ?? null,
        phone: academyRow?.phone ?? null,
        email: academyRow?.email ?? null,
        website: academyRow?.website ?? null,
        registrationNumber: academyRow?.registrationNumber ?? null,
      },
      student: { fullName: studentRow?.fullName ?? "Unknown student", studentNumber: studentRow?.studentNumber ?? "" },
      payment: {
        amountCents: paymentRow.amountCents,
        currency: paymentRow.currency,
        method: paymentRow.method,
        reference: paymentRow.reference,
        notes: paymentRow.notes,
        receivedAt: paymentRow.receivedAt,
        status: paymentRow.status,
      },
      description,
      recordedByLabel: recorderLabels.get(paymentRow.recordedBy) ?? paymentRow.recordedBy,
    },
  };
}
