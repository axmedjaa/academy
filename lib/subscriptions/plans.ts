import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { academies, academySubscriptions, subscriptionPlans } from "@/lib/db/schema";
import { sumObjectSizesByPrefix } from "@/lib/storage/client";
import { countAcademyResource, type UsageResource } from "@/lib/subscriptions/usage";
import { PLAN_LIMITS, type PlanLimitKey, type PlanLimits } from "@/lib/subscriptions/plan-catalog";
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
  code: "forbidden" | "validation" | "not_found" | "confirmation_required";
  message: string;
  /** Set with "confirmation_required": the academies a limit reduction
   * would leave over a limit. */
  impact?: PlanLimitImpact[];
}

/** One academy left over one lowered limit by a plan edit. */
export interface PlanLimitImpact {
  academyId: string;
  academyName: string;
  resource: UsageResource;
  label: string;
  current: number;
  newLimit: number;
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

// Zod mirror of the editable subscription_plans columns (migration 0040):
// price and every limit may be null (price not set / unlimited); features
// are the entitlements in lib/subscriptions/plan-catalog.ts. The retired
// certificate_enabled and reports_level columns are no longer edited.
const BILLING_PERIODS = ["monthly", "quarterly", "annual"] as const;

export type BillingPeriod = (typeof BILLING_PERIODS)[number];

const limitField = (label: string) =>
  z.number().int(`${label} must be a whole number`).nonnegative(`${label} cannot be negative`).nullable();

const planInputSchema = z.object({
  name: z.string().trim().min(1, "Plan name is required").max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
  /** null = price not set; the plan stays retired until priced. */
  priceAmountCents: z
    .number()
    .int("Price must be a whole number of cents")
    .nonnegative("Price cannot be negative")
    .nullable(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "Currency must be a 3-letter code, e.g. USD"),
  billingPeriod: z.enum(BILLING_PERIODS),
  maxBranches: limitField("Branch limit"),
  maxStudents: limitField("Student limit"),
  maxStaff: limitField("Staff limit"),
  maxCourses: limitField("Course limit"),
  maxStorageBytes: limitField("Storage limit"),
  smsEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  exportsEnabled: z.boolean(),
  advancedReportsEnabled: z.boolean(),
  /** Edit only: the owner confirmed saving limits below current usage. */
  confirmLimitReduction: z.boolean().optional(),
});

export type PlanInput = z.input<typeof planInputSchema>;

export interface SubscriptionPlanRecord {
  id: string;
  name: string;
  description: string | null;
  priceAmountCents: number | null;
  currency: string;
  billingPeriod: BillingPeriod;
  maxBranches: number | null;
  maxStudents: number | null;
  maxStaff: number | null;
  maxCourses: number | null;
  maxStorageBytes: number | null;
  smsEnabled: boolean;
  emailEnabled: boolean;
  exportsEnabled: boolean;
  advancedReportsEnabled: boolean;
  isActive: boolean;
  sortOrder: number;
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
    exportsEnabled: row.exportsEnabled,
    advancedReportsEnabled: row.advancedReportsEnabled,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
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
    .orderBy(asc(subscriptionPlans.sortOrder), subscriptionPlans.createdAt);

  return rows.map(toRecord);
}

export interface SubscriptionPlansPage {
  plans: SubscriptionPlanRecord[];
  totalCount: number;
}

/**
 * Perf investigation (Afoogy slow-dashboard task, query-performance step):
 * same list, same ordering, same "caller already checked plans.manage"
 * contract as `listSubscriptionPlans()` above — but for /platform/plans
 * (app/platform/plans/page.tsx), which only ever renders one `pageSize`-
 * row slice. That page previously called the unbounded function above and
 * sliced the already-fetched array in JS, which means every load shipped
 * the *entire* table across the wire first — currently thousands of rows
 * (see this task's test-data-isolation findings), not the tiny table
 * PLAN.md's seed data implies. `LIMIT`/`OFFSET` pushed into the query and
 * a separate `count(*)` for the page-nav total fixes that without touching
 * `listSubscriptionPlans()` itself, which other callers (the academy
 * registration plan picker, this file's own test) still rely on returning
 * every row.
 */
export async function listSubscriptionPlansPage(
  page: number,
  pageSize: number,
): Promise<SubscriptionPlansPage> {
  const offset = Math.max(0, page - 1) * pageSize;

  const [rows, [{ value: totalCount }]] = await Promise.all([
    db
      .select()
      .from(subscriptionPlans)
      .orderBy(asc(subscriptionPlans.sortOrder), subscriptionPlans.createdAt)
      .limit(pageSize)
      .offset(offset),
    db.select({ value: count() }).from(subscriptionPlans),
  ]);

  return { plans: rows.map(toRecord), totalCount };
}

/** Design P06 filter bar values. Price bands compare the plan's listed
 * price in its smallest unit: under 100.00, 100.00 to 199.99, 200.00 and up. */
export const PLAN_STATUS_FILTERS = ["active", "retired"] as const;
export const PLAN_PRICE_FILTERS = ["low", "mid", "high"] as const;

export interface SubscriptionPlanFilters {
  /** Case-insensitive match on the plan name ("Search plans by name"). */
  search?: string;
  /** "active" = selectable (is_active), "retired" = not. */
  status?: (typeof PLAN_STATUS_FILTERS)[number];
  price?: (typeof PLAN_PRICE_FILTERS)[number];
}

const planFiltersSchema = z.object({
  search: z.string().trim().min(1).max(200).optional().catch(undefined),
  status: z.enum(PLAN_STATUS_FILTERS).optional().catch(undefined),
  price: z.enum(PLAN_PRICE_FILTERS).optional().catch(undefined),
});

/** URL search params (`q`, `status`, `price`) -> filters. Unknown or
 * malformed values are ignored, so an old link shows every plan. */
export function parsePlanFilters(params: Record<string, string | string[] | undefined>): SubscriptionPlanFilters {
  const first = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const parsed = planFiltersSchema.parse({
    search: first("q") || undefined,
    status: first("status") || undefined,
    price: first("price") || undefined,
  });
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as SubscriptionPlanFilters;
}

const PRICE_BANDS_CENTS: Record<(typeof PLAN_PRICE_FILTERS)[number], [number | null, number | null]> = {
  low: [null, 10_000],
  mid: [10_000, 20_000],
  high: [20_000, null],
};

function planFilterWhere(filters: SubscriptionPlanFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.search) {
    const escaped = filters.search.replace(/[\\%_]/g, (char) => `\\${char}`);
    conditions.push(ilike(subscriptionPlans.name, `%${escaped}%`));
  }
  if (filters.status) conditions.push(eq(subscriptionPlans.isActive, filters.status === "active"));
  if (filters.price) {
    const [min, max] = PRICE_BANDS_CENTS[filters.price];
    if (min !== null) conditions.push(gte(subscriptionPlans.priceAmountCents, min));
    if (max !== null) conditions.push(lt(subscriptionPlans.priceAmountCents, max));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export interface FilteredSubscriptionPlansPage extends SubscriptionPlansPage {
  /** Every plan, unfiltered ("Showing X of Y plans"). */
  overallCount: number;
}

/** One page of /platform/plans with the P06 filters applied in SQL — same
 * ordering, LIMIT/OFFSET and "caller already checked plans.manage" contract
 * as `listSubscriptionPlansPage`; `totalCount` is the filtered total. */
export async function listFilteredSubscriptionPlansPage(
  filters: SubscriptionPlanFilters,
  page: number,
  pageSize: number,
): Promise<FilteredSubscriptionPlansPage> {
  const offset = Math.max(0, page - 1) * pageSize;
  const where = planFilterWhere(filters);
  const [rows, [{ value: totalCount }], [{ value: overallCount }]] = await Promise.all([
    db
      .select()
      .from(subscriptionPlans)
      .where(where)
      .orderBy(asc(subscriptionPlans.sortOrder), subscriptionPlans.createdAt, subscriptionPlans.id)
      .limit(pageSize)
      .offset(offset),
    db.select({ value: count() }).from(subscriptionPlans).where(where),
    db.select({ value: count() }).from(subscriptionPlans),
  ]);
  return { plans: rows.map(toRecord), totalCount, overallCount };
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
  const { confirmLimitReduction: _unused, ...data } = parsed.data;
  void _unused;

  const plan = await db.transaction(async (tx) => {
    const [last] = await tx
      .select({ max: sql<number | null>`max(${subscriptionPlans.sortOrder})` })
      .from(subscriptionPlans);
    const [row] = await tx
      .insert(subscriptionPlans)
      .values({
        ...data,
        // Retired column, no longer read (migration 0040).
        reportsLevel: "basic",
        sortOrder: (last?.max ?? 0) + 1,
        isActive: data.priceAmountCents !== null,
      })
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

  const parsedPlanId = z.string().uuid("A valid plan is required").safeParse(planId);
  if (!parsedPlanId.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsedPlanId.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }

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
  const { confirmLimitReduction, ...data } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .for("update")
      .limit(1);

    if (!existing) {
      return { kind: "not_found" as const };
    }
    if (existing.isActive && data.priceAmountCents === null) {
      return { kind: "needs_price" as const };
    }

    // Lowered limits: who would be left over? Nothing is deleted or
    // suspended either way; this only asks the owner to confirm.
    const impact = await computeLimitImpact(tx, planId, limitsOf(existing), limitsOf(data));
    if (impact.length > 0 && !confirmLimitReduction) {
      return { kind: "confirm" as const, impact };
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
        context:
          impact.length > 0
            ? { limitReductionConfirmed: true, academiesOverLimit: impact.map(({ academyId, resource, current, newLimit }) => ({ academyId, resource, current, newLimit })) }
            : undefined,
      },
      tx,
    );

    return { kind: "ok" as const, plan: updated };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: { code: "not_found", message: "Plan not found." } };
  }
  if (result.kind === "needs_price") {
    return {
      ok: false,
      error: { code: "validation", message: "An active plan needs a price. Retire the plan first to clear its price." },
    };
  }
  if (result.kind === "confirm") {
    const academiesCount = new Set(result.impact.map((row) => row.academyId)).size;
    return {
      ok: false,
      error: {
        code: "confirmation_required",
        message: `${academiesCount} ${academiesCount === 1 ? "academy is" : "academies are"} already above the new limits. They keep all their data but can't add more until they're under the limit.`,
        impact: result.impact,
      },
    };
  }

  return { ok: true, plan: toRecord(result.plan) };
}

function limitsOf(row: Record<PlanLimitKey, number | null>): PlanLimits {
  return Object.fromEntries(PLAN_LIMITS.map((limit) => [limit.key, row[limit.key]])) as PlanLimits;
}

/**
 * Academies whose current subscription is on this plan (the latest one by
 * starts_at, the same rule checkAllowance uses).
 */
async function academiesCurrentlyOnPlan(executor: DbClient, planId: string): Promise<{ id: string; name: string }[]> {
  const current = executor
    .selectDistinctOn([academySubscriptions.academyId], {
      academyId: academySubscriptions.academyId,
      planId: academySubscriptions.planId,
    })
    .from(academySubscriptions)
    .orderBy(academySubscriptions.academyId, desc(academySubscriptions.startsAt))
    .as("current_subscription");
  return executor
    .select({ id: academies.id, name: academies.name })
    .from(current)
    .innerJoin(academies, eq(academies.id, current.academyId))
    .where(eq(current.planId, planId));
}

/** Who a limit change would leave above a lowered limit (live counts). */
async function computeLimitImpact(
  executor: DbClient,
  planId: string,
  before: PlanLimits,
  after: PlanLimits,
): Promise<PlanLimitImpact[]> {
  const lowered = PLAN_LIMITS.filter((limit) => {
    const next = after[limit.key];
    const prev = before[limit.key];
    return next !== null && (prev === null || next < prev);
  });
  if (lowered.length === 0) return [];
  const onPlan = await academiesCurrentlyOnPlan(executor, planId);
  const impact: PlanLimitImpact[] = [];
  for (const academy of onPlan) {
    for (const limit of lowered) {
      const newLimit = after[limit.key] as number;
      let current: number;
      if (limit.resource === "storage") {
        const used = await sumObjectSizesByPrefix(`academies/${academy.id}/`);
        if (!used.ok) continue;
        current = used.totalBytes;
      } else {
        current = await countAcademyResource(executor, academy.id, limit.resource);
      }
      if (current > newLimit) {
        impact.push({ academyId: academy.id, academyName: academy.name, resource: limit.resource, label: limit.label, current, newLimit });
      }
    }
  }
  return impact;
}

/** How many academies are currently subscribed to each plan. */
export async function getPlanSubscriberCounts(planIds: string[]): Promise<Record<string, number>> {
  if (planIds.length === 0) return {};
  const current = db
    .selectDistinctOn([academySubscriptions.academyId], {
      academyId: academySubscriptions.academyId,
      planId: academySubscriptions.planId,
    })
    .from(academySubscriptions)
    .orderBy(academySubscriptions.academyId, desc(academySubscriptions.startsAt))
    .as("current_subscription");
  const rows = await db
    .select({ planId: current.planId, n: count() })
    .from(current)
    .where(inArray(current.planId, planIds))
    .groupBy(current.planId);
  return Object.fromEntries(rows.map((row) => [row.planId, row.n]));
}

/**
 * Plans that can be offered to new subscribers: active and priced, in the
 * owner's order. The landing page and Change plan use this.
 */
export async function listOfferablePlans(executor: DbClient = db): Promise<SubscriptionPlanRecord[]> {
  const rows = await executor
    .select()
    .from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.isActive, true), isNotNull(subscriptionPlans.priceAmountCents)))
    .orderBy(asc(subscriptionPlans.sortOrder), asc(subscriptionPlans.priceAmountCents), subscriptionPlans.name);
  return rows.map(toRecord);
}

export type MovePlanResult = { ok: true } | { ok: false; error: PlanActionError };

/**
 * Moves a plan one place up or down in the display order (Platform ->
 * Plans and the landing page). Renumbers the whole order so ties from
 * older plans resolve deterministically. Owner only, audited.
 */
export async function movePlan(
  actorContext: AuthContext,
  planId: string,
  direction: "up" | "down",
): Promise<MovePlanResult> {
  const forbidden = await requirePlansManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };
  if (!z.string().uuid().safeParse(planId).success || (direction !== "up" && direction !== "down")) {
    return { ok: false, error: { code: "validation", message: "Invalid input." } };
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('subscription_plans:order', 0))`);
    const ordered = await tx
      .select({ id: subscriptionPlans.id, sortOrder: subscriptionPlans.sortOrder })
      .from(subscriptionPlans)
      .orderBy(asc(subscriptionPlans.sortOrder), subscriptionPlans.createdAt, subscriptionPlans.id);
    const index = ordered.findIndex((row) => row.id === planId);
    if (index === -1) return { ok: false as const, error: { code: "not_found" as const, message: "Plan not found." } };
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= ordered.length) return { ok: true as const };
    const ids = ordered.map((row) => row.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    const changed = ids
      .map((id, position) => ({ id, order: position + 1 }))
      .filter(({ id, order }) => ordered.find((row) => row.id === id)?.sortOrder !== order);
    if (changed.length > 0) {
      await tx.execute(sql`
        update subscription_plans as p set sort_order = v.ord
        from unnest(${sql.raw(`ARRAY[${changed.map((c) => `'${c.id}'`).join(",")}]::uuid[]`)}, ${sql.raw(`ARRAY[${changed.map((c) => c.order).join(",")}]::int[]`)}) as v(id, ord)
        where p.id = v.id`);
    }
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        action: "reorderSubscriptionPlan",
        entityType: "subscription_plan",
        entityId: planId,
        before: { position: index + 1 },
        after: { position: target + 1 },
      },
      tx,
    );
    return { ok: true as const };
  });
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

  const parsedPlanId = z.string().uuid("A valid plan is required").safeParse(planId);
  if (!parsedPlanId.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsedPlanId.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);

    if (!existing) {
      return null;
    }
    if (isActive && existing.priceAmountCents === null) {
      return "needs_price" as const;
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
  if (result === "needs_price") {
    return { ok: false, error: { code: "validation", message: "Set a price before activating this plan." } };
  }

  return { ok: true, plan: toRecord(result) };
}
