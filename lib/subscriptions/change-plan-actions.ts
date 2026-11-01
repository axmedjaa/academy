"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import { changeAcademyPlan as changeAcademyPlanForActor, type ChangePlanResult } from "@/lib/subscriptions/change-plan";

/** Platform academy page: "Change plan" (platform owner only). */
export async function changeAcademyPlan(academyId: string, planId: string): Promise<ChangePlanResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: { code: "forbidden", message: "You must be signed in." } };
  const result = await changeAcademyPlanForActor(context, academyId, planId);
  if (result.ok) {
    revalidatePath(`/platform/academies/${academyId}`);
    revalidatePath("/platform/subscriptions");
    revalidatePath("/platform/usage");
  }
  return result;
}
