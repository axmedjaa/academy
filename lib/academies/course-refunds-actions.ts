"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  getCourseRefundPosition as getCourseRefundPositionForActor,
  withdrawStudentWithRefund as withdrawStudentWithRefundForActor,
  type CourseRefundError,
  type GetCourseRefundPositionResult,
  type WithdrawWithRefundInput,
  type WithdrawWithRefundResult,
} from "@/lib/academies/course-refunds";
import {
  listFeePeriodsForEnrollment as listFeePeriodsForEnrollmentForActor,
  type ListFeePeriodsResult,
} from "@/lib/academies/fee-periods";

/** Thin "use server" wrappers — same convention as
 * lib/academies/fee-periods-actions.ts. Every check (role, academy,
 * branch, enrollment state, refund cap) happens in course-refunds.ts. */
const UNAUTHENTICATED: CourseRefundError = { code: "forbidden", message: "You must be signed in." };

export async function getCourseRefundPositionAction(enrollmentId: string): Promise<GetCourseRefundPositionResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  return getCourseRefundPositionForActor(context, enrollmentId);
}

export interface WithdrawDialogData {
  /** null when the caller didn't ask for the period ledger (no fee schedule). */
  periods: ListFeePeriodsResult | null;
  position: GetCourseRefundPositionResult;
}

/**
 * Performance plan P6: everything the withdraw dialog loads, in ONE request.
 * Next.js dispatches client-called Server Actions one at a time, so the
 * dialog's previous pair of calls (fee-period ledger, then refund position)
 * always ran back to back. Both reads here are the exact same lib functions
 * those two actions call, each with its own permission and tenant checks,
 * just started together.
 */
export async function getWithdrawDialogDataAction(enrollmentId: string, includePeriods: boolean): Promise<WithdrawDialogData> {
  const context = await getAuthContext();
  if (!context) {
    return {
      periods: includePeriods ? { ok: false, error: { code: "forbidden", message: UNAUTHENTICATED.message } } : null,
      position: { ok: false, error: UNAUTHENTICATED },
    };
  }
  const [periods, position] = await Promise.all([
    includePeriods ? listFeePeriodsForEnrollmentForActor(context, enrollmentId) : Promise.resolve(null),
    getCourseRefundPositionForActor(context, enrollmentId),
  ]);
  return { periods, position };
}

export async function withdrawStudentWithRefundAction(input: WithdrawWithRefundInput): Promise<WithdrawWithRefundResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await withdrawStudentWithRefundForActor(context, input);
  if (result.ok) revalidatePath(`/academy/students/${result.refund.studentId}`);
  return result;
}
