"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  getEnrollmentFeeSchedule as getEnrollmentFeeScheduleForActor,
  listEnrollmentsForStudent as listEnrollmentsForStudentForActor,
  listFeePeriodsForEnrollment as listFeePeriodsForEnrollmentForActor,
  recordEnrollmentPayment as recordEnrollmentPaymentForActor,
  recordFeePeriodPayment as recordFeePeriodPaymentForActor,
  setEnrollmentFeeSchedule as setEnrollmentFeeScheduleForActor,
  type FeePeriodActionError,
  type GetEnrollmentFeeScheduleResult,
  type ListEnrollmentsForStudentResult,
  type ListFeePeriodsResult,
  type RecordEnrollmentPaymentInput,
  type RecordFeePeriodPaymentInput,
  type SetEnrollmentFeeScheduleInput,
} from "@/lib/academies/fee-periods";

/** Thin "use server" wrappers — same convention as
 * lib/academies/student-payments-actions.ts. Consumed by
 * app/academy/finance/fee-periods's client components. */
const UNAUTHENTICATED: FeePeriodActionError = { code: "forbidden", message: "You must be signed in." };

export interface FeePeriodsFormState {
  ok: boolean;
  error?: FeePeriodActionError;
}

export async function setEnrollmentFeeScheduleAction(input: SetEnrollmentFeeScheduleInput): Promise<FeePeriodsFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await setEnrollmentFeeScheduleForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/finance/fee-periods");
  return { ok: true };
}

export async function recordFeePeriodPaymentAction(input: RecordFeePeriodPaymentInput): Promise<FeePeriodsFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await recordFeePeriodPaymentForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/finance/fee-periods");
  revalidatePath("/academy/students", "layout");
  return { ok: true };
}

/** The simple "enter one amount" flow (Afoogy manual student-payment
 * verification report's required UX) — auto-allocates across outstanding
 * periods server-side; see recordEnrollmentPayment's own doc comment. */
export async function recordEnrollmentPaymentAction(input: RecordEnrollmentPaymentInput): Promise<FeePeriodsFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await recordEnrollmentPaymentForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/finance/fee-periods");
  revalidatePath("/academy/students", "layout");
  return { ok: true };
}

/** Plain read callables (no revalidation needed) — the fee-periods page
 * drives its student -> enrollment -> periods picker client-side, same
 * "plain async callable, not useActionState" convention as
 * lib/academies/academy-logo-actions.ts's request/confirm pair. */
export async function listEnrollmentsForStudentAction(studentId: string): Promise<ListEnrollmentsForStudentResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  return listEnrollmentsForStudentForActor(context, studentId);
}

export async function listFeePeriodsForEnrollmentAction(enrollmentId: string): Promise<ListFeePeriodsResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  return listFeePeriodsForEnrollmentForActor(context, enrollmentId);
}

export async function getEnrollmentFeeScheduleAction(enrollmentId: string): Promise<GetEnrollmentFeeScheduleResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  return getEnrollmentFeeScheduleForActor(context, enrollmentId);
}
