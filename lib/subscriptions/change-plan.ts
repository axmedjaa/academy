import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { academySubscriptions, subscriptionPlans } from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import { getAcademyLimitStatus, type LimitStatusRow } from "@/lib/subscriptions/usage";

/**
 * Platform owner moves an academy to another plan (platform academy page,
 * "Change plan"). The academy's current subscription (latest by
 * starts_at) switches to the new plan immediately, so its limits and
 * features apply at once. Nothing is charged or collected: payments are
 * recorded and verified by hand as before, and the new plan's price
 * applies from the next renewal. Existing subscription and payment records
 * keep their history. Data above the new plan's limits is never deleted
 * and the academy is not suspended; it just can't add more of that
 * resource until it's back under the limit (the returned `overLimit` rows).
 *
 * `changeAcademyPlan` is in UNGRANTABLE_CAPABILITIES: platform owner only.
 */
export const CHANGE_PLAN_CAPABILITY = "changeAcademyPlan";

export interface ChangePlanError {
  code: "forbidden" | "validation" | "not_found";
  message: string;
}

export type ChangePlanResult =
  | {
      ok: true;
      previousPlanName: string;
      planName: string;
      /** Resources the academy is now above (kept, not deleted). */
      overLimit: LimitStatusRow[];
    }
  | { ok: false; error: ChangePlanError };

export async function changeAcademyPlan(
  context: AuthContext,
  academyId: string,
  planId: string,
): Promise<ChangePlanResult> {
  if (!(await hasPermission(context, CHANGE_PLAN_CAPABILITY))) {
    return { ok: false, error: { code: "forbidden", message: "Only the platform owner can change an academy's plan." } };
  }
  if (!z.string().uuid().safeParse(academyId).success || !z.string().uuid().safeParse(planId).success) {
    return { ok: false, error: { code: "validation", message: "Choose a plan." } };
  }

  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: academySubscriptions.id, planId: academySubscriptions.planId })
      .from(academySubscriptions)
      .where(eq(academySubscriptions.academyId, academyId))
      .orderBy(desc(academySubscriptions.startsAt))
      .limit(1)
      .for("update");
    if (!current) return { kind: "no_subscription" as const };
    if (current.planId === planId) return { kind: "same" as const };

    const [target] = await tx
      .select({ id: subscriptionPlans.id, name: subscriptionPlans.name })
      .from(subscriptionPlans)
      .where(
        and(eq(subscriptionPlans.id, planId), eq(subscriptionPlans.isActive, true), isNotNull(subscriptionPlans.priceAmountCents)),
      )
      .limit(1);
    if (!target) return { kind: "unavailable" as const };

    const [previous] = await tx
      .select({ name: subscriptionPlans.name })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, current.planId))
      .limit(1);

    await tx
      .update(academySubscriptions)
      .set({ planId, updatedBy: context.userId })
      .where(eq(academySubscriptions.id, current.id));

    await recordAudit(
      {
        actorUserId: context.userId,
        actorRole: context.platformRole,
        academyId,
        action: "changeAcademyPlan",
        entityType: "academy_subscription",
        entityId: current.id,
        before: { planId: current.planId, planName: previous?.name ?? null },
        after: { planId, planName: target.name },
        context: { priceAppliesFrom: "next renewal", paymentCollected: false },
      },
      tx,
    );
    return { kind: "ok" as const, previousPlanName: previous?.name ?? "", planName: target.name };
  });

  if (outcome.kind === "no_subscription") {
    return { ok: false, error: { code: "not_found", message: "This academy has no subscription to change." } };
  }
  if (outcome.kind === "same") {
    return { ok: false, error: { code: "validation", message: "The academy is already on this plan." } };
  }
  if (outcome.kind === "unavailable") {
    return { ok: false, error: { code: "validation", message: "Choose an active plan with a price." } };
  }

  const status = await getAcademyLimitStatus(academyId);
  return {
    ok: true,
    previousPlanName: outcome.previousPlanName,
    planName: outcome.planName,
    overLimit: status ? status.rows.filter((row) => row.over) : [],
  };
}
