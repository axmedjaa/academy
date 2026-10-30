import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { batches, students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { branchScopeCondition, getBranchScope } from "@/lib/academies/branch-access";
import { getStudentDashboardCounts, type EnrollmentTrendPoint } from "@/lib/academies/student-reports";
import { listStaffSummaries } from "@/lib/academies/staff";
import { listUpcomingExams } from "@/lib/academies/exams";
import { listBranches } from "@/lib/academies/branches";
import {
  listPendingApprovalRequests,
  type ApprovalRequestEntityType,
} from "@/lib/academies/approval-requests";
import { getStudentPaymentTotals, type AmountByCurrency } from "@/lib/academies/finance-reports";
import { getOverdueFeeSummary, type OverdueFeeSummary } from "@/lib/academies/fee-periods";
import { getOwnAcademyUsage, type OwnAcademyUsageLimits, type OwnAcademyUsageMetrics } from "@/lib/academies/settings";
import { listStudentPayments, type StudentPaymentRecord } from "@/lib/academies/student-payments";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * `/academy/dashboard` (Screen Inventory A01) data. Every number comes from
 * an existing, already-gated read — getStudentReports / listStaff /
 * listExams / listPendingApprovalRequests / getFinanceReports /
 * getOwnAcademyUsage / listStudentPayments / listBranches — plus one pure
 * read, `getOverdueFeeSummary`, that only runs once `getFinanceReports` has
 * already confirmed the caller can see student payments. Nothing is
 * estimated or invented.
 *
 * Each source is fetched independently; a "forbidden" result from one only
 * removes that section for this role (DESIGN.md §3.1: hidden, not an error),
 * so a role with a narrow permission set still gets a useful page.
 *
 * Branch filter: `branchId` is honoured only when it is one of the branches
 * `listBranches` already returns for this caller (all branches for
 * academy-wide roles, assigned branches for branch-limited roles) — any
 * other value is ignored, so a crafted URL can never widen scope or reach
 * another academy's branch. Student, enrollment, payment, charge, overdue
 * and exam figures follow the filter; staff, approvals and plan usage are
 * academy-wide by nature and say so in the UI.
 */

export interface RecentPaymentRow {
  id: string;
  studentId: string;
  studentName: string;
  amountCents: number;
  currency: string;
  method: StudentPaymentRecord["method"];
  receivedAt: Date;
  status: StudentPaymentRecord["status"];
}

export interface DashboardBranchOption {
  id: string;
  name: string;
}

export interface NextExamSummary {
  id: string;
  name: string;
  batchName: string;
  examDate: string;
}

export interface PendingApprovalsSummary {
  total: number;
  /** Page holding the largest share of the pending items — where "Review"
   * sends the user. */
  href: string;
  /** Plain-language breakdown, e.g. "2 results, 1 expense". */
  breakdown: string;
}

export interface MoneySummary {
  count: number;
  totalsByCurrency: AmountByCurrency[];
}

export interface AcademyDashboardData {
  academyName: string;
  branchOptions: DashboardBranchOption[];
  selectedBranch: DashboardBranchOption | null;
  totalStudents: number | null;
  activeStudents: number | null;
  activeStaffCount: number | null;
  upcomingExamsCount: number | null;
  nextExam: NextExamSummary | null;
  pendingApprovals: PendingApprovalsSummary | null;
  outstandingCharges: MoneySummary | null;
  paymentsCollected: MoneySummary | null;
  overdueFees: OverdueFeeSummary | null;
  recentPayments: RecentPaymentRow[] | null;
  usage: { metrics: OwnAcademyUsageMetrics | null; limits: OwnAcademyUsageLimits | null } | null;
  /** Monthly new enrollments, oldest first ("YYYY-MM"). */
  enrollmentTrend: EnrollmentTrendPoint[] | null;
}

export type GetAcademyDashboardDataResult =
  | { ok: true; data: AcademyDashboardData }
  | { ok: false; error: { code: "blocked"; message: string } };

const CAN_SEE_APPROVALS_ROLES = new Set(["academy_owner", "academy_admin", "manager"]);

/** Reference: "Recent payments · Latest 5". */
const RECENT_PAYMENTS_LIMIT = 5;

const APPROVAL_BUCKETS: Record<ApprovalRequestEntityType, { href: string; noun: [string, string] }> = {
  result: { href: "/academy/results", noun: ["result", "results"] },
  grade_configuration: { href: "/academy/grades", noun: ["grade change", "grade changes"] },
  expense: { href: "/academy/finance", noun: ["expense", "expenses"] },
  student_payment: { href: "/academy/finance", noun: ["payment", "payments"] },
};

function summarizeApprovals(entityTypes: ApprovalRequestEntityType[]): PendingApprovalsSummary {
  const counts = new Map<ApprovalRequestEntityType, number>();
  for (const type of entityTypes) counts.set(type, (counts.get(type) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const top = sorted[0]?.[0];
  return {
    total: entityTypes.length,
    href: top ? APPROVAL_BUCKETS[top].href : "/academy/results",
    breakdown: sorted
      .map(([type, n]) => `${n} ${APPROVAL_BUCKETS[type].noun[n === 1 ? 0 : 1]}`)
      .join(", "),
  };
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getAcademyDashboardData(
  actorContext: AuthContext,
  options: { branchId?: string | null } = {},
): Promise<GetAcademyDashboardDataResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  const { academyId, membershipRole } = access;
  // Multi-branch: every figure below is limited to the caller's branches
  // when they don't have all-branch access (lib/academies/branch-access.ts).
  const scope = await getBranchScope(access, actorContext.userId);

  const branchesResult = await listBranches(actorContext);
  const branchOptions: DashboardBranchOption[] = branchesResult.ok
    ? branchesResult.branches
        .filter((branch) => branch.status === "active" || branch.id === options.branchId)
        .map((branch) => ({ id: branch.id, name: branch.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const selectedBranch = branchOptions.find((branch) => branch.id === options.branchId) ?? null;
  const branchId = selectedBranch?.id;

  // Performance plan P5: each figure comes from a purpose-built read with the
  // same gate, permission rule and scope as the full report it replaced
  // (getStudentReports, listStaff, listExams, getFinanceReports), computing
  // only what this page shows. The academy name comes from the access
  // gate's own academy row.
  const today = todayIsoDate();
  const [
    studentCountsResult,
    staffResult,
    examsResult,
    financeResult,
    usageResult,
    paymentsResult,
    pendingApprovalRequests,
  ] = await Promise.all([
    getStudentDashboardCounts(actorContext, branchId ? { branchId } : {}),
    listStaffSummaries(actorContext),
    listUpcomingExams(actorContext, today),
    getStudentPaymentTotals(actorContext, branchId ? { branchId } : {}),
    getOwnAcademyUsage(actorContext),
    listStudentPayments(actorContext, { limit: RECENT_PAYMENTS_LIMIT, branchId }),
    CAN_SEE_APPROVALS_ROLES.has(membershipRole) ? listPendingApprovalRequests(academyId, undefined, undefined, scope) : Promise.resolve(null),
  ]);
  const academyRow = access.academy.name || "Your academy";

  const totalStudents = studentCountsResult.ok ? studentCountsResult.counts.totalStudents : null;
  const activeStudents = studentCountsResult.ok
    ? (studentCountsResult.counts.statusBreakdown.find((row) => row.status === "active")?.count ?? 0)
    : null;
  const enrollmentTrend = studentCountsResult.ok ? studentCountsResult.counts.enrollmentTrend : null;
  const activeStaffCount = staffResult.ok
    ? staffResult.staff.filter((member) => member.status === "active").length
    : null;

  const finance = financeResult.ok && financeResult.totals.visible ? financeResult.totals : null;

  // Upcoming = still scheduled and dated today or later; the batch join
  // supplies both the display name and the branch for the branch filter.
  const scheduledExams = examsResult.ok
    ? examsResult.exams.filter(
        (exam): exam is typeof exam & { examDate: string } =>
          exam.status === "scheduled" && exam.examDate !== null && exam.examDate >= today,
      )
    : [];
  const examBatchIds = [...new Set(scheduledExams.map((exam) => exam.batchId))];
  const studentIdsForPayments = paymentsResult.ok
    ? [...new Set(paymentsResult.payments.map((payment) => payment.studentId))]
    : [];

  const [examBatchRows, paymentStudentNameRows, overdueFees] = await Promise.all([
    examBatchIds.length
      ? db
          .select({ id: batches.id, name: batches.name, branchId: batches.branchId })
          .from(batches)
          .where(and(eq(batches.academyId, academyId), inArray(batches.id, examBatchIds)))
      : Promise.resolve([]),
    studentIdsForPayments.length
      ? db
          .select({ id: students.id, fullName: students.fullName })
          .from(students)
          .where(and(eq(students.academyId, academyId), inArray(students.id, studentIdsForPayments)))
      : Promise.resolve([]),
    finance
      ? getOverdueFeeSummary(
          academyId,
          branchId,
          scope.academyWide
            ? undefined
            : db.select({ id: students.id }).from(students).where(and(eq(students.academyId, academyId), branchScopeCondition(scope, students.branchId))),
        )
      : Promise.resolve(null),
  ]);

  const batchById = new Map(examBatchRows.map((row) => [row.id, row]));
  const upcomingExams = scheduledExams
    .filter((exam) => {
      const batch = batchById.get(exam.batchId);
      return batch && (!branchId || batch.branchId === branchId);
    })
    .sort((a, b) => a.examDate.localeCompare(b.examDate));
  const upcomingExamsCount = examsResult.ok ? upcomingExams.length : null;
  const firstExam = upcomingExams[0];
  const nextExam: NextExamSummary | null = firstExam
    ? {
        id: firstExam.id,
        name: firstExam.name,
        batchName: batchById.get(firstExam.batchId)?.name ?? "",
        examDate: firstExam.examDate,
      }
    : null;

  let recentPayments: RecentPaymentRow[] | null = null;
  if (paymentsResult.ok) {
    const nameById = new Map(paymentStudentNameRows.map((row) => [row.id, row.fullName]));
    recentPayments = paymentsResult.payments.map((payment) => ({
      id: payment.id,
      studentId: payment.studentId,
      studentName: nameById.get(payment.studentId) ?? "Unknown student",
      amountCents: payment.amountCents,
      currency: payment.currency,
      method: payment.method,
      receivedAt: payment.receivedAt,
      status: payment.status,
    }));
  }

  return {
    ok: true,
    data: {
      academyName: academyRow,
      branchOptions,
      selectedBranch,
      totalStudents,
      activeStudents,
      activeStaffCount,
      upcomingExamsCount,
      nextExam,
      pendingApprovals: pendingApprovalRequests
        ? summarizeApprovals(pendingApprovalRequests.map((request) => request.entityType))
        : null,
      outstandingCharges: finance ? finance.outstandingCharges : null,
      paymentsCollected: finance ? finance.paymentsReceived : null,
      overdueFees,
      recentPayments,
      usage: usageResult.ok ? { metrics: usageResult.usage, limits: usageResult.limits } : null,
      enrollmentTrend,
    },
  };
}

