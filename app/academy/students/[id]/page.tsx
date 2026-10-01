import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getStudent } from "@/lib/academies/students";
import {
  getEnrollmentFeeSchedule,
  getEnrollmentPaymentSummary,
  listEnrollmentsForStudent,
  listFeePeriodPaymentHistory,
} from "@/lib/academies/fee-periods";
import { listReceiptsForPayments, listStudentCharges, listStudentPayments } from "@/lib/academies/student-payments";
import { resolveStaffLabels } from "@/lib/academies/staff-labels";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { StudentDetail, type PaymentHistoryRow } from "./student-detail";

/**
 * `/academy/students/[id]` — the student-centered payment workflow's home:
 * payment summary (per active enrollment), one-off charges, a merged
 * payment history (fee-period + charge payments in one table), and the
 * "Record Payment" action. Recording a payment here is immediately
 * effective — there is no approval step and no separate screen to visit
 * afterward (see lib/academies/student-payments.ts's module comment on the
 * "no approval workflow for student payments" architecture decision).
 *
 * Same graceful per-section degradation as app/academy/finance/page.tsx:
 * `academy.students` (view access, via getStudent), `academy.fee_periods`,
 * and `academy.student_payments` are three independently-gated permission
 * rows — a role with no access to one (e.g. Admissions Officer has "none"
 * on both finance rows) simply doesn't see that section, rather than the
 * whole page failing. Only a `getStudent` failure (no view access to the
 * student at all, or the id doesn't resolve/belongs to another academy)
 * blocks the page outright.
 */
export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const { id: studentId } = await params;

  const studentResult = await getStudent(context, studentId);
  if (!studentResult.ok) {
    return (
      <PageMessage
        title={studentResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={studentResult.error.message}
      />
    );
  }
  const { student } = studentResult;

  const enrollmentsResult = await listEnrollmentsForStudent(context, studentId);
  const enrollments = enrollmentsResult.ok ? enrollmentsResult.enrollments : [];
  const activeEnrollments = enrollments.filter((enrollment) => enrollment.status === "active");

  const [enrollmentSummaries, chargesResult, paymentsResult, feePeriodHistoryResult] = await Promise.all([
    Promise.all(
      activeEnrollments.map(async (enrollment) => {
        const [scheduleResult, summaryResult] = await Promise.all([
          getEnrollmentFeeSchedule(context, enrollment.id),
          getEnrollmentPaymentSummary(context, enrollment.id),
        ]);
        return {
          enrollment,
          schedule: scheduleResult.ok ? scheduleResult.schedule : null,
          summary: summaryResult.ok ? summaryResult.summary : null,
        };
      }),
    ),
    listStudentCharges(context, { studentId }),
    listStudentPayments(context, { studentId }),
    listFeePeriodPaymentHistory(context, { studentId }),
  ]);

  const charges = chargesResult.ok ? chargesResult.charges : [];
  const payments = paymentsResult.ok ? paymentsResult.payments : [];
  const canManagePayments = chargesResult.ok ? chargesResult.canManage : false;
  const canReversePayments = paymentsResult.ok ? paymentsResult.canReverse : false;
  const paymentsSectionVisible = chargesResult.ok || paymentsResult.ok;

  const feePeriodHistoryByPayment = new Map(
    (feePeriodHistoryResult.ok ? feePeriodHistoryResult.rows : []).map((row) => [row.paymentId, row]),
  );
  const chargeById = new Map(charges.map((charge) => [charge.id, charge]));
  const receiptsByPayment = await listReceiptsForPayments(context, payments.map((payment) => payment.id));

  // Display-only "recorded by" label — every recordedBy id here already
  // came from a payment row listStudentPayments already tenant-scoped and
  // authorized, so this is a display-field fetch on already-authorized
  // ids, not a fresh authorization decision (same reasoning as
  // app/academy/finance/page.tsx's own studentLabels lookup). Resolves to
  // the recorder's current role in this academy (e.g. "Manager"), falling
  // back to their email if their membership no longer exists.
  const recorderIds = payments.map((payment) => payment.recordedBy);
  const recorderLabelById = await resolveStaffLabels(student.academyId, recorderIds);

  const historyRows: PaymentHistoryRow[] = payments
    .map((payment) => {
      const feePeriodEntry = feePeriodHistoryByPayment.get(payment.id);
      const charge = payment.chargeId ? chargeById.get(payment.chargeId) : undefined;
      const receipt = receiptsByPayment.get(payment.id);
      const description = feePeriodEntry
        ? `${feePeriodEntry.courseName} — ${feePeriodEntry.batchName}: ${feePeriodEntry.periods
            .map((period) => `${period.periodStart} – ${period.periodEnd}`)
            .join(", ")}`
        : charge
          ? `Charge: ${charge.description}`
          : "—";
      return {
        paymentId: payment.id,
        receivedAt: payment.receivedAt,
        amountCents: payment.amountCents,
        currency: payment.currency,
        method: payment.method,
        reference: payment.reference,
        notes: payment.notes,
        status: payment.status,
        description,
        recordedByLabel: recorderLabelById.get(payment.recordedBy) ?? payment.recordedBy,
        recordedBy: payment.recordedBy,
        receiptId: receipt?.id ?? null,
        receiptNumber: receipt?.receiptNumber ?? null,
      };
    })
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title={student.fullName} description={`Student # ${student.studentNumber}`} />
      <StudentDetail
        student={student}
        enrollments={enrollments}
        enrollmentSummaries={enrollmentSummaries}
        charges={charges}
        historyRows={historyRows}
        paymentsSectionVisible={paymentsSectionVisible}
        canManagePayments={canManagePayments}
        canReversePayments={canReversePayments}
        currentUserId={context.userId}
      />
    </div>
  );
}
