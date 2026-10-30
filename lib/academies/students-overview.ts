import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { batchEnrollments, batches, studentCharges, studentPayments, students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { resolveScope } from "@/lib/academies/students";
import { getOverdueFeeSummary, getStudentPaymentSummaries } from "@/lib/academies/fee-periods";
import {
  ACADEMY_FEE_PERIODS_ACTION,
  ACADEMY_STUDENT_PAYMENTS_ACTION,
  ACADEMY_STUDENTS_ACTION,
  getAcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Students page summary (design A02 `bento` and filter-option counts).
 *
 * Gated exactly like `searchStudents` (any non-"none" level on the students
 * row) and scoped with the same `resolveScope`, so a Trainer's numbers only
 * ever cover the students they can already see, and an optional branch
 * filter narrows within the caller's own academy. Money figures need the
 * fee-period read permission; charge balances additionally need the
 * student-payments read permission. Balances use the existing rules:
 * fee periods via `getStudentPaymentSummaries` / `getOverdueFeeSummary`,
 * charges as amount minus approved payments (`recalculateStudentChargeStatus`).
 */

export type PaymentFilter = "unpaid" | "overdue" | "paid";

export interface StudentsOverview {
  total: number;
  active: number;
  archived: number;
  enrolled: number;
  needsEnrollment: number;
  batches: { id: string; name: string; count: number }[];
  noBatch: number;
  byBranch: Record<string, number>;
  finance: null | {
    overdueStudentCount: number;
    overdueTotals: { currency: string; amountCents: number }[];
    overdueByStudent: Record<string, { currency: string; amountCents: number }[]>;
    outstandingTotals: { currency: string; amountCents: number }[];
    paymentIds: Record<PaymentFilter, string[]>;
  };
}

export type GetStudentsOverviewResult = { ok: true; overview: StudentsOverview } | { ok: false };

function addTo(map: Map<string, number>, currency: string, cents: number) {
  if (cents > 0) map.set(currency, (map.get(currency) ?? 0) + cents);
}
const totalsOf = (map: Map<string, number>) =>
  [...map].map(([currency, amountCents]) => ({ currency, amountCents })).sort((a, b) => b.amountCents - a.amountCents);

export async function getStudentsOverview(
  actorContext: AuthContext,
  options: { branchId?: string } = {},
): Promise<GetStudentsOverviewResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false };
  const { academyId, membershipRole } = access;
  if (getAcademyPermissionLevel(membershipRole, ACADEMY_STUDENTS_ACTION) === "none") return { ok: false };

  const empty: StudentsOverview = {
    total: 0, active: 0, archived: 0, enrolled: 0, needsEnrollment: 0, batches: [], noBatch: 0, byBranch: {}, finance: null,
  };
  const scope = await resolveScope(access, actorContext.userId, options.branchId || undefined);
  if (scope.unreachable) return { ok: true, overview: empty };

  // Performance plan P4: the caller's scoped students stay in SQL. Counts are
  // aggregated by the database, and the batch counts and money summaries
  // take a subquery of the scoped ids instead of every id in the academy
  // shipped as query parameters. Same students, same rules, one fewer
  // sequential round trip.
  const scopeWhere = and(...scope.conditions);
  const scopedStudentIds = db.select({ id: students.id }).from(students).where(scopeWhere);

  const canSeeFees = getAcademyPermissionLevel(membershipRole, ACADEMY_FEE_PERIODS_ACTION) !== "none";
  const canSeeCharges = getAcademyPermissionLevel(membershipRole, ACADEMY_STUDENT_PAYMENTS_ACTION) !== "none";

  // "Enrolled" = has an active enrollment in this academy whose batch also
  // belongs to this academy — the same join the batch counts below use.
  const hasActiveEnrollment = sql<boolean>`exists (
    select 1 from ${batchEnrollments}
    inner join ${batches} on ${batches.id} = ${batchEnrollments.batchId} and ${batches.academyId} = ${academyId}
    where ${batchEnrollments.studentId} = ${students.id}
      and ${batchEnrollments.academyId} = ${academyId}
      and ${batchEnrollments.status} = 'active'
  )`;

  const [countRows, batchRows, summaries, overdue, chargeRows] = await Promise.all([
    db
      .select({
        status: students.status,
        branchId: students.branchId,
        total: sql<number>`count(*)::int`,
        enrolled: sql<number>`count(*) filter (where ${hasActiveEnrollment})::int`,
      })
      .from(students)
      .where(scopeWhere)
      .groupBy(students.status, students.branchId),
    db
      .select({
        batchId: batchEnrollments.batchId,
        batchName: batches.name,
        count: sql<number>`count(distinct ${batchEnrollments.studentId})::int`,
      })
      .from(batchEnrollments)
      .innerJoin(batches, and(eq(batches.id, batchEnrollments.batchId), eq(batches.academyId, academyId)))
      .where(
        and(
          eq(batchEnrollments.academyId, academyId),
          eq(batchEnrollments.status, "active"),
          inArray(batchEnrollments.studentId, scopedStudentIds),
        ),
      )
      .groupBy(batchEnrollments.batchId, batches.name),
    canSeeFees ? getStudentPaymentSummaries(academyId, scopedStudentIds) : Promise.resolve(null),
    canSeeFees ? getOverdueFeeSummary(academyId, null, scopedStudentIds) : Promise.resolve(null),
    canSeeFees && canSeeCharges
      ? db
          .select({
            currency: studentCharges.currency,
            amountCents: studentCharges.amountCents,
            paidCents: sql<number>`coalesce((select sum(${studentPayments.amountCents}) from ${studentPayments} where ${studentPayments.chargeId} = ${studentCharges.id} and ${studentPayments.status} = 'approved'), 0)::int`,
          })
          .from(studentCharges)
          .where(
            and(
              eq(studentCharges.academyId, academyId),
              inArray(studentCharges.studentId, scopedStudentIds),
              inArray(studentCharges.status, ["open", "partially_paid"]),
            ),
          )
      : Promise.resolve([]),
  ]);

  let total = 0;
  let active = 0;
  let activeEnrolled = 0;
  let enrolledAnyStatus = 0;
  const byBranch: Record<string, number> = {};
  for (const row of countRows) {
    total += row.total;
    enrolledAnyStatus += row.enrolled;
    if (row.status === "active") {
      active += row.total;
      activeEnrolled += row.enrolled;
    }
    byBranch[row.branchId] = (byBranch[row.branchId] ?? 0) + row.total;
  }
  if (total === 0) return { ok: true, overview: empty };

  const overview: StudentsOverview = {
    total,
    active,
    archived: total - active,
    enrolled: activeEnrolled,
    needsEnrollment: active - activeEnrolled,
    batches: batchRows
      .map((row) => ({ id: row.batchId, name: row.batchName, count: row.count }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    noBatch: total - enrolledAnyStatus,
    byBranch,
    finance: null,
  };

  if (summaries && overdue) {
    const outstanding = new Map<string, number>();
    const paymentIds: Record<PaymentFilter, string[]> = { unpaid: [], overdue: [], paid: [] };
    for (const [studentId, summary] of summaries) {
      addTo(outstanding, summary.currency, summary.remainingCents);
      if (summary.remainingCents > 0) paymentIds.unpaid.push(studentId);
      if (summary.status === "overdue") paymentIds.overdue.push(studentId);
      if (summary.expectedCents > 0 && summary.remainingCents <= 0) paymentIds.paid.push(studentId);
    }
    for (const charge of chargeRows) addTo(outstanding, charge.currency, charge.amountCents - charge.paidCents);
    overview.finance = {
      overdueStudentCount: overdue.studentCount,
      overdueTotals: overdue.totalsByCurrency,
      overdueByStudent: overdue.byStudent,
      outstandingTotals: totalsOf(outstanding),
      paymentIds,
    };
  }

  return { ok: true, overview };
}
