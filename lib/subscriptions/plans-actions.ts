"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  createSubscriptionPlan as createSubscriptionPlanForActor,
  updateSubscriptionPlan as updateSubscriptionPlanForActor,
  setPlanActive as setPlanActiveForActor,
  type PlanActionError,
  type PlanInput,
} from "@/lib/subscriptions/plans";

const UNAUTHENTICATED: PlanActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface PlanFormState {
  ok: boolean;
  error?: PlanActionError;
}

/**
 * FormData -> PlanInput. Left loose/untyped-looking on purpose — every
 * field is re-validated by lib/subscriptions/plans.ts's Zod schema right
 * after this runs, so this is just shape translation, not validation
 * (Cross-Cutting Architecture Decisions: "every server action's input is
 * Zod-validated" happens one layer down, in the pure logic module).
 */
function parsePlanFormData(formData: FormData): PlanInput {
  const description = String(formData.get("description") ?? "").trim();
  return {
    name: String(formData.get("name") ?? ""),
    description: description.length > 0 ? description : null,
    priceAmountCents: Number(formData.get("priceAmountCents")),
    currency: String(formData.get("currency") ?? ""),
    billingPeriod: String(formData.get("billingPeriod") ?? "") as PlanInput["billingPeriod"],
    maxBranches: Number(formData.get("maxBranches")),
    maxStudents: Number(formData.get("maxStudents")),
    maxStaff: Number(formData.get("maxStaff")),
    maxCourses: Number(formData.get("maxCourses")),
    maxStorageBytes: Number(formData.get("maxStorageBytes")),
    smsEnabled: formData.get("smsEnabled") === "on",
    emailEnabled: formData.get("emailEnabled") === "on",
    certificateEnabled: formData.get("certificateEnabled") === "on",
    reportsLevel: String(formData.get("reportsLevel") ?? "") as PlanInput["reportsLevel"],
  };
}

/**
 * PLAN.md §4 server action name. Form-bound via useActionState (same
 * pattern as lib/platform-staff/actions.ts's createPlatformAdminAccount)
 * since plan creation has field-level validation errors to surface.
 */
export async function createSubscriptionPlan(
  _prevState: PlanFormState,
  formData: FormData,
): Promise<PlanFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createSubscriptionPlanForActor(
    context,
    parsePlanFormData(formData),
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/plans");
  return { ok: true };
}

/** PLAN.md §4 server action name. See createSubscriptionPlan above. */
export async function updateSubscriptionPlan(
  _prevState: PlanFormState,
  formData: FormData,
): Promise<PlanFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const planId = String(formData.get("planId") ?? "");
  const result = await updateSubscriptionPlanForActor(
    context,
    planId,
    parsePlanFormData(formData),
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/plans");
  return { ok: true };
}

/**
 * PLAN.md §4 server action name. Called directly (not through
 * useActionState) from the Retire/Restore toggle button, matching
 * lib/platform-staff/actions.ts's grantPlatformPermission pattern for a
 * single fire-and-check-result action rather than a form.
 */
export async function setPlanActive(
  planId: string,
  isActive: boolean,
): Promise<{ ok: true } | { ok: false; error: PlanActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await setPlanActiveForActor(context, planId, isActive);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/plans");
  return { ok: true };
}
