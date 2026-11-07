import { and, eq } from "drizzle-orm";
import { inBranchScope, type BranchScope } from "@/lib/academies/branch-access";
import { db } from "@/lib/db";
import { feePeriods, paymentAllocations, studentPayments, students } from "@/lib/db/schema";

/**
 * Replay lookup for `student_payments` (SEC-M-06). Three operations write
 * that table — a charge/one-off payment (recordStudentPayment) and a
 * fee-period payment (recordFeePeriodPayment, also reached through
 * recordEnrollmentPayment) — so the caller decides whether the row found
 * matches its own operation and details.
 *
 * Tenant and authorization: the lookup is limited to the actor's academy,
 * and a row whose student is outside the actor's branch scope is reported
 * as "out_of_scope", never returned.
 */
export type KeyedStudentPayment =
  | { kind: "none" }
  | { kind: "out_of_scope" }
  | {
      kind: "found";
      payment: typeof studentPayments.$inferSelect;
      allocations: { feePeriodId: string; enrollmentId: string; amountCents: number }[];
    };

export async function findKeyedStudentPayment(academyId: string, scope: BranchScope, key: string): Promise<KeyedStudentPayment> {
  const [row] = await db
    .select({ payment: studentPayments, branchId: students.branchId })
    .from(studentPayments)
    .innerJoin(students, eq(students.id, studentPayments.studentId))
    .where(and(eq(studentPayments.academyId, academyId), eq(studentPayments.idempotencyKey, key)))
    .limit(1);
  if (!row) return { kind: "none" };
  if (!inBranchScope(scope, row.branchId)) return { kind: "out_of_scope" };

  const allocations = await db
    .select({
      feePeriodId: paymentAllocations.feePeriodId,
      enrollmentId: feePeriods.enrollmentId,
      amountCents: paymentAllocations.amountCents,
    })
    .from(paymentAllocations)
    .innerJoin(feePeriods, eq(feePeriods.id, paymentAllocations.feePeriodId))
    .where(eq(paymentAllocations.studentPaymentId, row.payment.id));

  return { kind: "found", payment: row.payment, allocations };
}
