"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  createSubscriptionPlan as createSubscriptionPlanForActor,
  updateSubscriptionPlan as updateSubscriptionPlanForActor,
  setPlanActive as setPlanActiveForActor,
  movePlan as movePlanForActor,
  type PlanActionError,
  type PlanInput,
} from "@/lib/subscriptions/plans";
import { PLAN_FEATURES, PLAN_LIMITS } from "@/lib/subscriptions/plan-catalog";
import { dollarsToCents } from "@/lib/ui/money";

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
/** The "Price" field is entered in dollars, not cents (Platform Owner
 * screen) — see lib/ui/money.ts's dollarsToCents. */
function parsePlanFormData(formData: FormData): PlanInput {
  const description = String(formData.get("description") ?? "").trim();
  const price = String(formData.get("priceDollars") ?? "").trim();
  // Each limit: "<key>Unlimited" = on means unlimited (null); otherwise the
  // number field (storage arrives in bytes, converted by the form).
  const limits = Object.fromEntries(
    PLAN_LIMITS.map((limit) => [
      limit.key,
      formData.get(`${limit.key}Unlimited`) === "on" ? null : Number(formData.get(limit.key)),
    ]),
  ) as Pick<PlanInput, (typeof PLAN_LIMITS)[number]["key"]>;
  const features = Object.fromEntries(
    PLAN_FEATURES.map((feature) => [feature.column, formData.get(feature.column) === "on"]),
  ) as Pick<PlanInput, (typeof PLAN_FEATURES)[number]["column"]>;
  return {
    name: String(formData.get("name") ?? ""),
    description: description.length > 0 ? description : null,
    // Empty = price not set (the plan stays retired until priced).
    priceAmountCents: price === "" ? null : (dollarsToCents(price) ?? Number.NaN),
    currency: String(formData.get("currency") ?? ""),
    billingPeriod: String(formData.get("billingPeriod") ?? "") as PlanInput["billingPeriod"],
    ...limits,
    ...features,
    confirmLimitReduction: formData.get("confirmLimitReduction") === "1",
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
  revalidatePath("/");
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
  revalidatePath("/");
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
  revalidatePath("/");
  return { ok: true };
}

/** Platform -> Plans: move a plan one place up or down (owner only). */
export async function movePlan(
  planId: string,
  direction: "up" | "down",
): Promise<{ ok: true } | { ok: false; error: PlanActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  const result = await movePlanForActor(context, planId, direction);
  if (result.ok) {
    revalidatePath("/platform/plans");
    revalidatePath("/");
  }
  return result;
}
