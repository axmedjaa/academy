import { listOfferablePlans } from "@/lib/subscriptions/plans";
import { PLAN_FEATURES, type PlanFeatureKey, type PlanLimits } from "@/lib/subscriptions/plan-catalog";

/**
 * Pricing data for the public landing page (app/page.tsx), read live from
 * subscription_plans: every active plan that has a price, in the platform
 * owner's order (Platform -> Plans). Limits and features are the same
 * values the server enforces (lib/subscriptions/usage.ts,
 * lib/subscriptions/entitlements.ts), so the cards can't promise more than
 * the product delivers. Nothing here is hard-coded.
 */

export interface LandingPlan {
  id: string;
  name: string;
  description: string | null;
  priceAmountCents: number;
  currency: string;
  billingPeriod: "monthly" | "quarterly" | "annual";
  /** null per limit = unlimited. */
  limits: PlanLimits;
  /** Plan features that are switched on. */
  features: PlanFeatureKey[];
}

export async function getLandingPlans(): Promise<LandingPlan[]> {
  const plans = await listOfferablePlans();
  return plans.flatMap((plan) =>
    plan.priceAmountCents === null
      ? []
      : [
          {
            id: plan.id,
            name: plan.name,
            description: plan.description,
            priceAmountCents: plan.priceAmountCents,
            currency: plan.currency,
            billingPeriod: plan.billingPeriod,
            limits: {
              maxBranches: plan.maxBranches,
              maxStudents: plan.maxStudents,
              maxStaff: plan.maxStaff,
              maxCourses: plan.maxCourses,
              maxStorageBytes: plan.maxStorageBytes,
            },
            features: PLAN_FEATURES.filter((feature) => plan[feature.column]).map((feature) => feature.key),
          },
        ],
  );
}
