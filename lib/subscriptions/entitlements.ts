import { desc, eq } from "drizzle-orm";
import { db, type DbClient } from "@/lib/db";
import { academySubscriptions, subscriptionPlans } from "@/lib/db/schema";
import { PLAN_FEATURES, type PlanFeatureKey } from "@/lib/subscriptions/plan-catalog";

/**
 * Server-side feature entitlements: which plan features the academy's
 * current subscription includes. The current plan is the academy's latest
 * subscription by starts_at, the same rule limit checks use. Every check
 * runs on the server for each request; the UI only reflects the answer.
 *
 * Enforcement points:
 * - sms, email: lib/notifications/notifications.ts (channel rows)
 * - advancedReports: getFinanceReports, getAcademicReports
 * - exports: exportData (every academy CSV export)
 */

export type Entitlements = Record<PlanFeatureKey, boolean>;

const NONE: Entitlements = Object.fromEntries(PLAN_FEATURES.map((feature) => [feature.key, false])) as Entitlements;

export async function getAcademyEntitlements(academyId: string, executor: DbClient = db): Promise<Entitlements> {
  const [row] = await executor
    .select({
      smsEnabled: subscriptionPlans.smsEnabled,
      emailEnabled: subscriptionPlans.emailEnabled,
      advancedReportsEnabled: subscriptionPlans.advancedReportsEnabled,
      exportsEnabled: subscriptionPlans.exportsEnabled,
    })
    .from(academySubscriptions)
    .innerJoin(subscriptionPlans, eq(academySubscriptions.planId, subscriptionPlans.id))
    .where(eq(academySubscriptions.academyId, academyId))
    .orderBy(desc(academySubscriptions.startsAt))
    .limit(1);
  if (!row) return { ...NONE };
  return Object.fromEntries(PLAN_FEATURES.map((feature) => [feature.key, row[feature.column]])) as Entitlements;
}

export interface FeatureUnavailableError {
  code: "feature_unavailable";
  message: string;
}

const UNAVAILABLE_MESSAGE: Record<PlanFeatureKey, string> = {
  sms: "SMS notifications aren't included in this academy's plan.",
  email: "Email notifications aren't included in this academy's plan.",
  advancedReports:
    "Finance and academic reports aren't included in this academy's plan. Ask the platform owner about upgrading.",
  exports: "Data exports aren't included in this academy's plan. Ask the platform owner about upgrading.",
};

/** The one server-side gate for a plan feature. */
export async function requireFeature(
  academyId: string,
  feature: PlanFeatureKey,
  executor: DbClient = db,
): Promise<{ ok: true } | { ok: false; error: FeatureUnavailableError }> {
  const entitlements = await getAcademyEntitlements(academyId, executor);
  return entitlements[feature]
    ? { ok: true }
    : { ok: false, error: { code: "feature_unavailable", message: UNAVAILABLE_MESSAGE[feature] } };
}
