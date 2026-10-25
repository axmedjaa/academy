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
  const scope = await resolveScope(academyId, membershipRole, actorContext.userId, options.branchId || undefined);
  if (scope.unreachable) return { ok: true, overview: empty };

  const rows = await db
    .select({ id: students.id, status: students.status, branchId: students.branchId })
    .from(students)
    .where(and(...scope.conditions));
  if (rows.length === 0) return { ok: true, overview: empty };
  const ids = rows.map((row) => row.id);

  const canSeeFees = getAcademyPermissionLevel(membershipRole, ACADEMY_FEE_PERIODS_ACTION) !== "none";
  const canSeeCharges = getAcademyPermissionLevel(membershipRole, ACADEMY_STUDENT_PAYMENTS_ACTION) !== "none";

  const [enrollRows, summaries, overdue, chargeRows] = await Promise.all([
    db
      .select({ studentId: batchEnrollments.studentId, batchId: batchEnrollments.batchId, batchName: batches.name })
      .from(batchEnrollments)
      .innerJoin(batches, and(eq(batches.id, batchEnrollments.batchId), eq(batches.academyId, academyId)))
      .where(and(eq(batchEnrollments.academyId, academyId), eq(batchEnrollments.status, "active"), inArray(batchEnrollments.studentId, ids))),
    canSeeFees ? getStudentPaymentSummaries(academyId, ids) : Promise.resolve(null),
    canSeeFees ? getOverdueFeeSummary(academyId, null, ids) : Promise.resolve(null),
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
              inArray(studentCharges.studentId, ids),
              inArray(studentCharges.status, ["open", "partially_paid"]),
            ),
          )
      : Promise.resolve([]),
  ]);

  const enrolledIds = new Set(enrollRows.map((row) => row.studentId));
  const batchCounts = new Map<string, { id: string; name: string; students: Set<string> }>();
  for (const row of enrollRows) {
    const entry = batchCounts.get(row.batchId) ?? { id: row.batchId, name: row.batchName, students: new Set<string>() };
    entry.students.add(row.studentId);
    batchCounts.set(row.batchId, entry);
  }
  const byBranch: Record<string, number> = {};
  for (const row of rows) byBranch[row.branchId] = (byBranch[row.branchId] ?? 0) + 1;

  const activeRows = rows.filter((row) => row.status === "active");
  const overview: StudentsOverview = {
    total: rows.length,
    active: activeRows.length,
    archived: rows.length - activeRows.length,
    enrolled: activeRows.filter((row) => enrolledIds.has(row.id)).length,
    needsEnrollment: activeRows.filter((row) => !enrolledIds.has(row.id)).length,
    batches: [...batchCounts.values()]
      .map((entry) => ({ id: entry.id, name: entry.name, count: entry.students.size }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    noBatch: rows.filter((row) => !enrolledIds.has(row.id)).length,
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
