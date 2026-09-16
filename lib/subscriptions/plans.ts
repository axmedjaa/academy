import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { subscriptionPlans } from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";

// PLAN.md §4/§5, Master Permission Matrix: "Manage subscription plans
// (pricing) — plans.manage | Full | — (never grantable)". Already present
// in UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts), so hasPermission()
// returns true for this capability only for platform_owner — no
// platform_admin grant can ever satisfy it.
const PLANS_MANAGE_CAPABILITY = "plans.manage";

export interface PlanActionError {
  code: "forbidden" | "validation" | "not_found";
  message: string;
}

const FORBIDDEN: PlanActionError = {
  code: "forbidden",
  message: "You don't have permission to manage subscription plans.",
};

async function requirePlansManagePermission(
  actorContext: AuthContext,
): Promise<PlanActionError | null> {
  const allowed = await hasPermission(actorContext, PLANS_MANAGE_CAPABILITY);
  return allowed ? null : FORBIDDEN;
}

// PLAN.md's own column list (Phase 1 §2) for subscription_plans. Zod schema
// mirrors it field-for-field; see lib/db/schema.ts for the judgment calls
// behind the billing_period/reports_level value sets and the
// max_storage_bytes bigint choice.
const BILLING_PERIODS = ["monthly", "quarterly", "annual"] as const;
const REPORTS_LEVELS = ["none", "basic", "advanced"] as const;

export type BillingPeriod = (typeof BILLING_PERIODS)[number];
export type ReportsLevel = (typeof REPORTS_LEVELS)[number];

const planInputSchema = z.object({
  name: z.string().trim().min(1, "Plan name is required").max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
  priceAmountCents: z
    .number()
    .int("Price must be a whole number of cents")
    .nonnegative("Price cannot be negative"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "Currency must be a 3-letter code, e.g. USD"),
  billingPeriod: z.enum(BILLING_PERIODS),
  maxBranches: z.number().int().nonnegative("Branch limit cannot be negative"),
  maxStudents: z.number().int().nonnegative("Student limit cannot be negative"),
  maxStaff: z.number().int().nonnegative("Staff limit cannot be negative"),
  maxCourses: z.number().int().nonnegative("Course limit cannot be negative"),
  maxStorageBytes: z
    .number()
    .int()
    .nonnegative("Storage limit cannot be negative"),
  smsEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  certificateEnabled: z.boolean(),
  reportsLevel: z.enum(REPORTS_LEVELS),
});

export type PlanInput = z.input<typeof planInputSchema>;

export interface SubscriptionPlanRecord {
  id: string;
  name: string;
  description: string | null;
  priceAmountCents: number;
  currency: string;
  billingPeriod: BillingPeriod;
  maxBranches: number;
  maxStudents: number;
  maxStaff: number;
  maxCourses: number;
  maxStorageBytes: number;
  smsEnabled: boolean;
  emailEnabled: boolean;
  certificateEnabled: boolean;
  reportsLevel: ReportsLevel;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(
  row: typeof subscriptionPlans.$inferSelect,
): SubscriptionPlanRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceAmountCents: row.priceAmountCents,
    currency: row.currency,
    billingPeriod: row.billingPeriod as BillingPeriod,
    maxBranches: row.maxBranches,
    maxStudents: row.maxStudents,
    maxStaff: row.maxStaff,
    maxCourses: row.maxCourses,
    maxStorageBytes: row.maxStorageBytes,
    smsEnabled: row.smsEnabled,
    emailEnabled: row.emailEnabled,
    certificateEnabled: row.certificateEnabled,
    reportsLevel: row.reportsLevel as ReportsLevel,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Lists every subscription plan (active and retired) for the
 * /platform/plans list view. Callers must already have checked
 * hasPermission(context, "plans.manage") themselves — this helper does not
 * re-check, matching listPlatformStaff()'s convention (lib/platform-staff/
 * staff.ts) of gating once at the page level rather than in every helper it
 * calls.
 */
export async function listSubscriptionPlans(): Promise<
  SubscriptionPlanRecord[]
> {
  const rows = await db
    .select()
    .from(subscriptionPlans)
    .orderBy(subscriptionPlans.createdAt);

  return rows.map(toRecord);
}

export type CreateSubscriptionPlanResult =
  | { ok: true; plan: SubscriptionPlanRecord }
  | { ok: false; error: PlanActionError };

/**
 * PLAN.md §4: createSubscriptionPlan, capability plans.manage
 * (ungrantable — platform_owner only).
 */
export async function createSubscriptionPlan(
  actorContext: AuthContext,
  input: PlanInput,
): Promise<CreateSubscriptionPlanResult> {
  const forbidden = await requirePlansManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const parsed = planInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }
  const data = parsed.data;

  const plan = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(subscriptionPlans)
      .values(data)
      .returning();

    // Same-transaction audit write (Cross-Cutting Architecture Decisions:
    // "the audit write happens in the same database transaction as the
    // mutation it protects").
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        action: "createSubscriptionPlan",
        entityType: "subscription_plan",
        entityId: row.id,
        after: data,
      },
      tx,
    );

    return row;
  });

  return { ok: true, plan: toRecord(plan) };
}

export type UpdateSubscriptionPlanResult =
  | { ok: true; plan: SubscriptionPlanRecord }
  | { ok: false; error: PlanActionError };

/**
 * PLAN.md §4: updateSubscriptionPlan, capability plans.manage
 * (ungrantable — platform_owner only). Full-object update (not a partial
 * PATCH) — DESIGN.md §8 describes one "create/edit form" for
 * /platform/plans, i.e. the edit form resubmits every field each time
 * rather than diffing individual fields client-side. Does not touch
 * is_active — that's setPlanActive's sole job, matching PLAN.md listing
 * them as two separate named actions.
 */
export async function updateSubscriptionPlan(
  actorContext: AuthContext,
  planId: string,
  input: PlanInput,
): Promise<UpdateSubscriptionPlanResult> {
  const forbidden = await requirePlansManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const parsed = planInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);

    if (!existing) {
      return null;
    }

    const [updated] = await tx
      .update(subscriptionPlans)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(subscriptionPlans.id, planId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        action: "updateSubscriptionPlan",
        entityType: "subscription_plan",
        entityId: planId,
        before: toRecord(existing),
        after: data,
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return {
      ok: false,
      error: { code: "not_found", message: "Plan not found." },
    };
  }

  return { ok: true, plan: toRecord(result) };
}

export type SetPlanActiveResult =
  | { ok: true; plan: SubscriptionPlanRecord }
  | { ok: false; error: PlanActionError };

/**
 * PLAN.md §4: setPlanActive, capability plans.manage (ungrantable —
 * platform_owner only). DESIGN.md §8: "Retire (not delete) if any academy
 * is on it" — this is the retire (isActive: false) / restore
 * (isActive: true) action; there is no deletePlan action anywhere in
 * PLAN.md. Whether any academy_subscriptions row currently references this
 * plan isn't checked here: that table doesn't exist yet (PLAN.md Item 23,
 * not yet built in this codebase) — retiring a plan already in use is safe
 * regardless, since is_active only gates whether the plan can be selected
 * for a new or renewed subscription, never an existing one's continued
 * validity.
 */
export async function setPlanActive(
  actorContext: AuthContext,
  planId: string,
  isActive: boolean,
): Promise<SetPlanActiveResult> {
  const forbidden = await requirePlansManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);

    if (!existing) {
      return null;
    }

    const [updated] = await tx
      .update(subscriptionPlans)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(subscriptionPlans.id, planId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        action: "setPlanActive",
        entityType: "subscription_plan",
        entityId: planId,
        before: { isActive: existing.isActive },
        after: { isActive },
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return {
      ok: false,
      error: { code: "not_found", message: "Plan not found." },
    };
  }

  return { ok: true, plan: toRecord(result) };
}
