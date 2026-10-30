import { redirect } from "next/navigation";
import { formatDate } from "@/lib/ui/date";
import { describeAllocations } from "@/lib/ui/payment-allocations";
import { getRefundedAmountsForPayments, listStudentRefunds } from "@/lib/academies/course-refunds";
import type { RefundHistoryRow } from "./payment-history";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getStudent, getStudentDeletionEligibility, getStudentPhotoUrl } from "@/lib/academies/students";
import {
  getEnrollmentFeeSchedule,
  getEnrollmentPaymentSummary,
  listEnrollmentsForStudent,
  listFeePeriodPaymentHistory,
  todayDateOnlyInAcademyTimezone,
} from "@/lib/academies/fee-periods";
import { listReceiptsForPayments, listStudentCharges, listStudentPayments } from "@/lib/academies/student-payments";
import { resolveStaffLabels } from "@/lib/academies/staff-labels";
import { PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";
import { listBranches } from "@/lib/academies/branches";
import { getEnrollBatchOptions } from "@/lib/academies/enroll-options";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { ACADEMY_STUDENTS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { listEnrollmentWithdrawals } from "@/lib/academies/batch-assignments";
import { listTimetableForBatches } from "@/lib/academies/timetables";
import { StudentDetail, type PaymentHistoryRow } from "./student-detail";
import type { EnrollmentDetail } from "./student-overview";

const DAY_SHORT: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

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
export default async function StudentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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
  const photoUrl = await getStudentPhotoUrl(student.profileImageRef);

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
  const refundedByPayment = await getRefundedAmountsForPayments(student.academyId, payments.map((payment) => payment.id));
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
      const appliesTo = feePeriodEntry
        ? describeAllocations(feePeriodEntry.periods).label
        : charge
          ? `Charge: ${charge.description}`
          : "Not linked to a fee period or charge";
      const appliesToDetail = feePeriodEntry
        ? feePeriodEntry.periods.map((period) => `${formatDate(period.periodStart)} – ${formatDate(period.periodEnd)}`).join(", ")
        : null;
      return {
        paymentId: payment.id,
        appliesTo,
        appliesToDetail,
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
        refundedCents: refundedByPayment.get(payment.id) ?? 0,
      };
    })
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

  // Header and tab data: branch name, edit rights (same gate updateStudent
  // checks) and the enroll options (scoped batches with their courses).
  const pastEnrollments = enrollments.filter((enrollment) => enrollment.status !== "active");
  const [branchesResult, enrollOptions, access, timetableResult, withdrawals, refundsResult] = await Promise.all([
    listBranches(context),
    getEnrollBatchOptions(context),
    checkAcademyAccessForContext(context),
    listTimetableForBatches(context, activeEnrollments.map((enrollment) => enrollment.batchId)),
    listEnrollmentWithdrawals(context, pastEnrollments.map((enrollment) => enrollment.id)),
    listStudentRefunds(context, studentId),
  ]);
  // Refunds recorded on withdrawal (their own records, never payments).
  const refunds = refundsResult.ok ? refundsResult.refunds : null;
  const refundRecorderLabels = refunds?.length
    ? await resolveStaffLabels(student.academyId, refunds.map((refund) => refund.recordedBy))
    : new Map<string, string>();
  const refundRows: RefundHistoryRow[] = (refunds ?? []).map((refund) => ({
    id: refund.id,
    refundedAt: refund.refundedAt,
    appliesTo: `${refund.courseName} · ${refund.batchName}`,
    method: refund.method,
    amountCents: refund.amountCents,
    currency: refund.currency,
    reference: refund.reference,
    reason: refund.reason,
    recordedByLabel: refundRecorderLabels.get(refund.recordedBy) ?? "Staff member",
    paymentCount: refund.payments.length,
  }));
  // Same gate and rules as the Students list's Delete: refused (null here)
  // for roles that may not delete; otherwise eligible or the reasons why not.
  const deletionResult = await getStudentDeletionEligibility(context, studentId);
  const deletion = deletionResult.ok
    ? { eligible: deletionResult.eligibility.eligible, reasons: deletionResult.eligibility.reasons }
    : null;

  // Design A02 course tables. Enrolled: the weekly schedule and trainer of
  // each course ("Mon/Wed 09:00 to 11:00"). Past: what was paid and
  // reversed for that course (from its fee-period allocations) and when /
  // why it was withdrawn (from the withdraw audit entry).
  const enrollmentDetails: Record<string, EnrollmentDetail> = {};
  for (const enrollment of activeEnrollments) {
    if (!timetableResult.ok) {
      enrollmentDetails[enrollment.id] = { schedule: null, trainers: null };
      continue;
    }
    const slots = timetableResult.entries.filter(
      (entry) => entry.batchId === enrollment.batchId && entry.courseId === enrollment.courseId,
    );
    const byTime = new Map<string, string[]>();
    for (const slot of [...slots].sort((a, b) => DAY_ORDER.indexOf(a.dayOfWeek) - DAY_ORDER.indexOf(b.dayOfWeek))) {
      const range = `${slot.startTime.slice(0, 5)} to ${slot.endTime.slice(0, 5)}`;
      byTime.set(range, [...(byTime.get(range) ?? []), DAY_SHORT[slot.dayOfWeek] ?? slot.dayOfWeek]);
    }
    enrollmentDetails[enrollment.id] = {
      schedule: [...byTime].map(([range, days]) => `${days.join("/")} ${range}`).join(", "),
      trainers: [...new Set(slots.map((slot) => slot.trainerName).filter((name): name is string => Boolean(name)))],
    };
  }
  const historyRowsForPast = feePeriodHistoryResult.ok ? feePeriodHistoryResult.rows : null;
  for (const enrollment of pastEnrollments) {
    const withdrawal = withdrawals.get(enrollment.id);
    let paidCents: number | null = null;
    let currency: string | null = null;
    if (historyRowsForPast) {
      paidCents = 0;
      for (const row of historyRowsForPast) {
        const allocated = row.periods
          .filter((period) => period.enrollmentId === enrollment.id)
          .reduce((n, period) => n + period.amountCents, 0);
        if (allocated === 0) continue;
        currency = currency ?? row.currency;
        if (row.status === "approved") paidCents += allocated;
      }
    }
    // Refunded: actual refund records for this enrollment (never reversals).
    const enrollmentRefunds = refunds?.filter((refund) => refund.enrollmentId === enrollment.id) ?? null;
    if (enrollmentRefunds?.length) currency = currency ?? enrollmentRefunds[0].currency;
    enrollmentDetails[enrollment.id] = {
      paidCents,
      refundedCents: enrollmentRefunds ? enrollmentRefunds.reduce((n, refund) => n + refund.amountCents, 0) : null,
      currency,
      withdrawnAt: withdrawal?.withdrawnAt ?? null,
      withdrawReason: withdrawal?.reason ?? null,
    };
  }
  const branchName =
    (branchesResult.ok ? branchesResult.branches.find((b) => b.id === student.branchId)?.name : undefined) ?? "Branch";
  const studentsLevel = access.level === "blocked" ? "none" : getAcademyPermissionLevel(access.membershipRole, ACADEMY_STUDENTS_ACTION);
  const canEditStudent = studentsLevel === "full" || studentsLevel === "manage";

  return (
    <div className={PAGE_WRAP}>
      <StudentDetail
        initialTab={(await searchParams).tab === "fees" ? "fees" : (await searchParams).tab === "payments" ? "payments" : "overview"}
        student={student}
        photoUrl={photoUrl}
        branchName={branchName}
        canEditStudent={canEditStudent}
        canEnroll={enrollOptions.canEnroll}
        enrollBatches={enrollOptions.batches}
        enrollments={enrollments}
        enrollmentSummaries={enrollmentSummaries}
        enrollmentDetails={enrollmentDetails}
        deletion={deletion}
        charges={charges}
        historyRows={historyRows}
        refundRows={refundRows}
        paymentsSectionVisible={paymentsSectionVisible}
        canManagePayments={canManagePayments}
        canReversePayments={canReversePayments}
        currentUserId={context.userId}
        today={todayDateOnlyInAcademyTimezone()}
      />
    </div>
  );
}
