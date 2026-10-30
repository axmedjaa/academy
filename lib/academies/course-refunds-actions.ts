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

/** Thin "use server" wrappers — same convention as
 * lib/academies/fee-periods-actions.ts. Every check (role, academy,
 * branch, enrollment state, refund cap) happens in course-refunds.ts. */
const UNAUTHENTICATED: CourseRefundError = { code: "forbidden", message: "You must be signed in." };

export async function getCourseRefundPositionAction(enrollmentId: string): Promise<GetCourseRefundPositionResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  return getCourseRefundPositionForActor(context, enrollmentId);
}

export async function withdrawStudentWithRefundAction(input: WithdrawWithRefundInput): Promise<WithdrawWithRefundResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await withdrawStudentWithRefundForActor(context, input);
  if (result.ok) revalidatePath(`/academy/students/${result.refund.studentId}`);
  return result;
}
