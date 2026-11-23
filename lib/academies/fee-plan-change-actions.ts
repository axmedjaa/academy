"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  changeFeePlan,
  getFeePlanPosition,
  type ChangeFeePlanInput,
  type FeePlanChangeError,
  type FeePlanPosition,
  type FeePlanTarget,
} from "@/lib/academies/fee-plan-change";

/** Thin "use server" wrappers — same convention as fee-periods-actions.ts. */
const UNAUTHENTICATED: FeePlanChangeError = { code: "forbidden", message: "You must be signed in." };

export async function getFeePlanPositionAction(
  target: FeePlanTarget,
): Promise<{ ok: true; position: FeePlanPosition } | { ok: false; error: FeePlanChangeError }> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  return getFeePlanPosition(context, target);
}

export async function changeFeePlanAction(input: ChangeFeePlanInput): Promise<{ ok: boolean; error?: FeePlanChangeError }> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await changeFeePlan(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath("/academy/finance", "layout");
  revalidatePath("/academy/batches", "layout");
  revalidatePath(`/academy/students/${result.studentId}`);
  return { ok: true };
}
