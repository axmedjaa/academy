import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getStudentReports } from "@/lib/academies/student-reports";
import { listStaff } from "@/lib/academies/staff";
import { listExams } from "@/lib/academies/exams";
import { listPendingApprovalRequests } from "@/lib/academies/approval-requests";
import { getFinanceReports, type FinanceReportsData } from "@/lib/academies/finance-reports";
import { getOwnAcademyUsage, type OwnAcademyUsageLimits, type OwnAcademyUsageMetrics } from "@/lib/academies/settings";
import { listStudentPayments, type StudentPaymentRecord } from "@/lib/academies/student-payments";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * DESIGN.md §9.1 — `/academy/dashboard`'s real content ("custom layout.
 * Summary cards (active students, staff, upcoming exams, pending
 * approvals, recent payments), alerts..., compact usage indicator...
 * linking to Settings"). This replaces app/academy/dashboard/page.tsx's
 * Item 28 placeholder.
 *
 * Every number here comes from an existing, already-gated read
 * (getStudentReports/listStaff/listExams/listPendingApprovalRequests/
 * getFinanceReports/getOwnAcademyUsage/listStudentPayments) — nothing new is
 * computed, per this task's "do not invent metrics that don't exist in the
 * backend" instruction. Each source is fetched independently and a
 * "forbidden"/"blocked" result from one is treated as "this card is simply
 * omitted for this role" (mirrors DESIGN.md §3.1 Permission-denied: hidden,
 * not shown as an error) rather than failing the whole page — different
 * academy roles hold very different permission sets (e.g. Admissions
 * Officer has no access to staff or finance at all), so a single "one
 * source failed" should never blank the entire dashboard for that role.
 */
export interface DashboardAlert {
  message: string;
  tone: "amber" | "red";
}

export interface RecentPaymentRow {
  id: string;
  studentName: string;
  amountCents: number;
  currency: string;
  method: StudentPaymentRecord["method"];
  receivedAt: Date;
  status: StudentPaymentRecord["status"];
}

type VisibleStudentPaymentsSection = Extract<FinanceReportsData["studentPayments"], { visible: true }>;

export interface AcademyDashboardData {
  totalStudents: number | null;
  activeStaffCount: number | null;
  upcomingExamsCount: number | null;
  pendingApprovalsCount: number | null;
  recentPayments: RecentPaymentRow[] | null;
  usage: { metrics: OwnAcademyUsageMetrics | null; limits: OwnAcademyUsageLimits | null } | null;
  finance: VisibleStudentPaymentsSection | null;
  alerts: DashboardAlert[];
}

export type GetAcademyDashboardDataResult =
  | { ok: true; data: AcademyDashboardData }
  | { ok: false; error: { code: "blocked"; message: string } };

const CAN_SEE_APPROVALS_ROLES = new Set(["academy_owner", "academy_admin", "manager"]);

export async function getAcademyDashboardData(
  actorContext: AuthContext,
): Promise<GetAcademyDashboardDataResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const [studentReportsResult, staffResult, examsResult, financeResult, usageResult, paymentsResult] =
    await Promise.all([
      getStudentReports(actorContext, {}),
      listStaff(actorContext),
      listExams(actorContext),
      getFinanceReports(actorContext, {}),
      getOwnAcademyUsage(actorContext),
      listStudentPayments(actorContext),
    ]);

  const totalStudents = studentReportsResult.ok ? studentReportsResult.report.totalStudents : null;
  const activeStaffCount = staffResult.ok ? staffResult.staff.length : null;

  const now = new Date();
  const upcomingExamsCount = examsResult.ok
    ? examsResult.exams.filter(
        (exam) => exam.status === "scheduled" && exam.examDate !== null && new Date(exam.examDate) >= now,
      ).length
    : null;

  const pendingApprovalsCount = CAN_SEE_APPROVALS_ROLES.has(access.membershipRole)
    ? (await listPendingApprovalRequests(access.academyId)).length
    : null;

  const usage =
    usageResult.ok ? { metrics: usageResult.usage, limits: usageResult.limits } : null;

  const finance = financeResult.ok && financeResult.report.studentPayments.visible
    ? financeResult.report.studentPayments
    : null;

  let recentPayments: RecentPaymentRow[] | null = null;
  if (paymentsResult.ok) {
    const sorted = [...paymentsResult.payments].sort(
      (a, b) => b.receivedAt.getTime() - a.receivedAt.getTime(),
    );
    const top = sorted.slice(0, 5);
    const studentIds = [...new Set(top.map((payment) => payment.studentId))];
    const nameRows = studentIds.length
      ? await db
          .select({ id: students.id, fullName: students.fullName })
          .from(students)
          .where(and(eq(students.academyId, access.academyId), inArray(students.id, studentIds)))
      : [];
    const nameById = new Map(nameRows.map((row) => [row.id, row.fullName]));

    recentPayments = top.map((payment) => ({
      id: payment.id,
      studentName: nameById.get(payment.studentId) ?? "Unknown student",
      amountCents: payment.amountCents,
      currency: payment.currency,
      method: payment.method,
      receivedAt: payment.receivedAt,
      status: payment.status,
    }));
  }

  const alerts: DashboardAlert[] = [];
  if (pendingApprovalsCount !== null && pendingApprovalsCount > 0) {
    alerts.push({
      message: `${pendingApprovalsCount} item${pendingApprovalsCount === 1 ? "" : "s"} awaiting your approval.`,
      tone: "amber",
    });
  }
  if (finance && finance.outstandingCharges.count > 0) {
    alerts.push({
      message: `${finance.outstandingCharges.count} outstanding charge${finance.outstandingCharges.count === 1 ? "" : "s"}.`,
      tone: "amber",
    });
  }
  if (
    usage?.metrics &&
    usage.limits &&
    usage.limits.maxStudents > 0 &&
    usage.metrics.activeStudentsCount / usage.limits.maxStudents >= 1
  ) {
    alerts.push({ message: "This academy is at its student allowance limit.", tone: "red" });
  }

  return {
    ok: true,
    data: {
      totalStudents,
      activeStaffCount,
      upcomingExamsCount,
      pendingApprovalsCount,
      recentPayments,
      usage,
      finance,
      alerts,
    },
  };
}
