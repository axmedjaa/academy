import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  academyUsage,
  branches,
  subscriptionPlans,
} from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md Phase 1, Item 29 — "`academy_usage` table + `recalculateUsage`/
 * `checkAllowance()` logic + a `/platform/usage` page."
 *
 * -----------------------------------------------------------------------
 * Capability judgment call
 * -----------------------------------------------------------------------
 * PLAN.md's Master Permission Matrix (§5) closes the Phase 1 grantable
 * list at exactly three capabilities: `recordSubscriptionPayment`,
 * `queryAuditLogs`, and read access to `getPlatformReports`' non-revenue
 * views — it never names a dedicated "usage" capability, and
 * `lib/auth/permissions.ts` (off-limits for this item) has no
 * usage-specific entry either. `/platform/usage` (DESIGN.md §4.1's
 * "Usage & Allowances" nav item) is a read-only, non-revenue,
 * informational screen — "over-limit rows visually flagged even though
 * this view is informational (enforcement happens at creation time, not
 * here)" (DESIGN.md §7 route table) — which is exactly the shape
 * `getPlatformReports`' non-revenue views already cover. Rather than
 * inventing a new identifier `hasPermission()` doesn't know about (which
 * would silently never be grantable to any `platform_admin`, since
 * `UNGRANTABLE_CAPABILITIES` is a closed allow-list-by-exclusion and
 * anything not in `GRANTABLE_CAPABILITIES` either is unreachable for an
 * admin), this reuses `getPlatformReports` for both viewing the page and
 * triggering `recalculateUsage` (a "refresh this report" action, not a
 * billing-state mutation — it never changes a subscription, a plan, or
 * any academy's access). Documented here as the judgment call it is.
 */
const USAGE_VIEW_CAPABILITY = "getPlatformReports";

export const USAGE_RESOURCES = [
  "branches",
  "students",
  "staff",
  "courses",
  "storage",
] as const;

export type UsageResource = (typeof USAGE_RESOURCES)[number];

export interface AcademyUsageSnapshot {
  id: string;
  academyId: string;
  activeStudentsCount: number;
  activeStaffCount: number;
  branchCount: number;
  courseCount: number;
  storageUsedBytes: number;
  calculatedAt: Date;
}

function toSnapshot(row: typeof academyUsage.$inferSelect): AcademyUsageSnapshot {
  return {
    id: row.id,
    academyId: row.academyId,
    activeStudentsCount: row.activeStudentsCount,
    activeStaffCount: row.activeStaffCount,
    branchCount: row.branchCount,
    courseCount: row.courseCount,
    storageUsedBytes: row.storageUsedBytes,
    calculatedAt: row.calculatedAt,
  };
}

/**
 * Per-metric counters, keyed by `UsageResource`. This is the extensibility
 * seam the task brief asks for: `branches` is the only resource with a
 * real source-of-truth table in this codebase today (Item 19's `branches`),
 * so it is the only counter that queries anything. `students`/`staff`/
 * `courses`/`storage` have no backing tables yet anywhere in this
 * codebase (Phase 2+: `students`, `staff_profiles`, `courses`, and file
 * storage tracking) — their counters are explicit `0`-returning stubs, not
 * a silently-faked nonzero number, each documented with exactly which
 * later item is expected to replace it. `recalculateUsage` and
 * `checkAllowance` both go through this map so a later phase only ever
 * has to change the counter function itself, never the two callers below.
 */
async function countActiveBranches(
  executor: DbClient,
  academyId: string,
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(branches)
    .where(and(eq(branches.academyId, academyId), eq(branches.status, "active")));
  return row?.count ?? 0;
}

// Phase 2 (`students` table, not yet built) will replace this with a real
// COUNT of active students for the academy. Returning 0 rather than
// omitting the metric keeps academy_usage's column list exactly as
// PLAN.md specifies it, and keeps checkAllowance("students") well-defined
// (current=0 against any positive plan limit is simply never blocking
// until real students can exist to count).
async function countActiveStudents(
  executor: DbClient,
  academyId: string,
): Promise<number> {
  // Params kept (not dropped) so this matches metricCounters' shared
  // signature exactly — same "keep the parameter, void it" convention as
  // hasPermission()'s unused `resource` param (lib/auth/permissions.ts).
  void executor;
  void academyId;
  return 0;
}

// Phase 2 (`staff_profiles` table, not yet built). See countActiveStudents.
async function countActiveStaff(executor: DbClient, academyId: string): Promise<number> {
  void executor;
  void academyId;
  return 0;
}

// Phase 3 (`courses` table, not yet built). See countActiveStudents.
async function countCourses(executor: DbClient, academyId: string): Promise<number> {
  void executor;
  void academyId;
  return 0;
}

// Phase 2 (academy-owned file storage / upload tracking, not yet built —
// PLAN.md's "Storage" allowance means academy-owned files only: student/
// staff documents, ID photos, academy logo). See countActiveStudents.
async function countStorageUsedBytes(
  executor: DbClient,
  academyId: string,
): Promise<number> {
  void executor;
  void academyId;
  return 0;
}

const metricCounters: Record<
  UsageResource,
  (executor: DbClient, academyId: string) => Promise<number>
> = {
  branches: countActiveBranches,
  students: countActiveStudents,
  staff: countActiveStaff,
  courses: countCourses,
  storage: countStorageUsedBytes,
};

const RESOURCE_TO_PLAN_LIMIT_COLUMN = {
  branches: "maxBranches",
  students: "maxStudents",
  staff: "maxStaff",
  courses: "maxCourses",
  storage: "maxStorageBytes",
} as const satisfies Record<UsageResource, keyof typeof subscriptionPlans.$inferSelect>;

export interface UsageActionError {
  code: "forbidden" | "validation" | "not_found" | "no_plan";
  message: string;
}

const FORBIDDEN: UsageActionError = {
  code: "forbidden",
  message: "You don't have permission to view or recalculate academy usage.",
};

/**
 * "Current" plan/limits for an academy — same convention as
 * lib/academies/access-gate.ts's checkAcademyAccess: no unique/"is
 * current" flag exists on academy_subscriptions, so the row with the
 * latest starts_at is the current one (the only way an academy
 * accumulates more than one row is a Cancelled subscription being
 * replaced by a brand-new one, per PLAN.md Phase 1 §6).
 */
async function getCurrentPlanLimits(
  executor: DbClient,
  academyId: string,
): Promise<typeof subscriptionPlans.$inferSelect | null> {
  const [row] = await executor
    .select({ plan: subscriptionPlans })
    .from(academySubscriptions)
    .innerJoin(subscriptionPlans, eq(academySubscriptions.planId, subscriptionPlans.id))
    .where(eq(academySubscriptions.academyId, academyId))
    .orderBy(desc(academySubscriptions.startsAt))
    .limit(1);

  return row?.plan ?? null;
}

export interface CheckAllowanceResult {
  allowed: boolean;
  resource: UsageResource;
  current: number;
  limit: number;
}

export type CheckAllowanceOutcome =
  | { ok: true; result: CheckAllowanceResult }
  | { ok: false; error: UsageActionError };

/**
 * PLAN.md §4: `checkAllowance(academyId, resource)` — "a single ...
 * helper ... called at the top of every capped-resource create action
 * (branches, staff, students, courses, storage uploads) ... Hard block —
 * the action fails ... if the academy is at its plan limit."
 *
 * Deliberately takes no actor/AuthContext, matching PLAN.md's literal
 * two-argument signature everywhere it names this function — like
 * `createAcademySubscription`, this is an internal helper meant to be
 * called from inside an already-permission-gated create action (Items
 * 34/35/38/43, not yet built), not a user-facing action of its own. It is
 * a pure read with no persisted side effect, so it does not audit — there
 * is nothing to record beyond what the calling action's own audit row
 * already captures.
 *
 * Always recomputes the current count live via `metricCounters` rather
 * than trusting the last-persisted `academy_usage` snapshot: DESIGN.md §7
 * is explicit that `/platform/usage` is "informational (enforcement
 * happens at creation time, not here)" — the enforcement path and the
 * display path are intentionally decoupled, so the hard block here can
 * never be stale because a platform owner hasn't clicked "Recalculate"
 * recently.
 *
 * `executor` accepts a transaction client so a future capped-resource
 * create action can call this inside the same transaction as its insert.
 */
export async function checkAllowance(
  academyId: string,
  resource: UsageResource,
  executor: DbClient = db,
): Promise<CheckAllowanceOutcome> {
  const parsedAcademyId = z.string().uuid().safeParse(academyId);
  if (!parsedAcademyId.success) {
    return {
      ok: false,
      error: { code: "validation", message: "Invalid academy id." },
    };
  }

  const plan = await getCurrentPlanLimits(executor, academyId);
  if (!plan) {
    return {
      ok: false,
      error: {
        code: "no_plan",
        message: "This academy has no subscription/plan to check allowance against.",
      },
    };
  }

  const limit = plan[RESOURCE_TO_PLAN_LIMIT_COLUMN[resource]] as number;
  const current = await metricCounters[resource](executor, academyId);

  return {
    ok: true,
    result: { allowed: current < limit, resource, current, limit },
  };
}

export type RecalculateUsageResult =
  | { ok: true; usage: AcademyUsageSnapshot }
  | { ok: false; error: UsageActionError };

/**
 * PLAN.md §4: `recalculateUsage` — the mutating counterpart to
 * `checkAllowance`. Recomputes every metric in `metricCounters` from
 * source-of-truth tables and inserts a fresh `academy_usage` snapshot row
 * (see schema.ts's comment on `academyUsage` for why this is an
 * append-only snapshot rather than an upsert-in-place single row).
 * Audited like every other mutation in this codebase, in the same
 * transaction as the insert.
 *
 * Requires `getPlatformReports` (see module comment above for why).
 */
export async function recalculateUsage(
  actorContext: AuthContext,
  academyId: string,
): Promise<RecalculateUsageResult> {
  const allowed = await hasPermission(actorContext, USAGE_VIEW_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedAcademyId = z.string().uuid().safeParse(academyId);
  if (!parsedAcademyId.success) {
    return {
      ok: false,
      error: { code: "validation", message: "Invalid academy id." },
    };
  }

  const [academy] = await db
    .select({ id: academies.id })
    .from(academies)
    .where(eq(academies.id, academyId))
    .limit(1);
  if (!academy) {
    return { ok: false, error: { code: "not_found", message: "Academy not found." } };
  }

  const result = await db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(academyUsage)
      .where(eq(academyUsage.academyId, academyId))
      .orderBy(desc(academyUsage.calculatedAt))
      .limit(1);

    const [
      activeStudentsCount,
      activeStaffCount,
      branchCount,
      courseCount,
      storageUsedBytes,
    ] = await Promise.all([
      metricCounters.students(tx, academyId),
      metricCounters.staff(tx, academyId),
      metricCounters.branches(tx, academyId),
      metricCounters.courses(tx, academyId),
      metricCounters.storage(tx, academyId),
    ]);

    const [row] = await tx
      .insert(academyUsage)
      .values({
        academyId,
        activeStudentsCount,
        activeStaffCount,
        branchCount,
        courseCount,
        storageUsedBytes,
      })
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId,
        action: "recalculateUsage",
        entityType: "academy_usage",
        entityId: row.id,
        before: previous ? toSnapshot(previous) : null,
        after: toSnapshot(row),
      },
      tx,
    );

    return row;
  });

  return { ok: true, usage: toSnapshot(result) };
}

export interface AcademyUsageOverviewRow {
  academyId: string;
  academyName: string;
  planName: string | null;
  usage: AcademyUsageSnapshot | null;
  limits: {
    maxBranches: number;
    maxStudents: number;
    maxStaff: number;
    maxCourses: number;
    maxStorageBytes: number;
  } | null;
}

/**
 * Data for the `/platform/usage` list page: every academy, its latest
 * `academy_usage` snapshot (if `recalculateUsage` has ever run for it),
 * and its current plan's limits (if it has a subscription). Batch-fetched
 * (three queries total, reduced in memory) rather than one query per
 * academy, since "latest row per academy_id" has no single clean Drizzle
 * query builder expression without raw SQL window functions — fine at
 * platform-admin scale (this is not a tenant-facing hot path).
 *
 * Callers must already have checked `hasPermission(context,
 * "getPlatformReports")` themselves — this helper does not re-check,
 * matching `listSubscriptionPlans()`'s convention (lib/subscriptions/
 * plans.ts) of gating once at the page level.
 */
export async function listAcademyUsageOverview(): Promise<AcademyUsageOverviewRow[]> {
  const academyRows = await db
    .select({ id: academies.id, name: academies.name })
    .from(academies)
    .orderBy(academies.name);

  const subscriptionRows = await db
    .select({
      academyId: academySubscriptions.academyId,
      startsAt: academySubscriptions.startsAt,
      planName: subscriptionPlans.name,
      maxBranches: subscriptionPlans.maxBranches,
      maxStudents: subscriptionPlans.maxStudents,
      maxStaff: subscriptionPlans.maxStaff,
      maxCourses: subscriptionPlans.maxCourses,
      maxStorageBytes: subscriptionPlans.maxStorageBytes,
    })
    .from(academySubscriptions)
    .innerJoin(subscriptionPlans, eq(academySubscriptions.planId, subscriptionPlans.id))
    .orderBy(desc(academySubscriptions.startsAt));

  const usageRows = await db
    .select()
    .from(academyUsage)
    .orderBy(desc(academyUsage.calculatedAt));

  const latestSubscriptionByAcademy = new Map<string, (typeof subscriptionRows)[number]>();
  for (const row of subscriptionRows) {
    if (!latestSubscriptionByAcademy.has(row.academyId)) {
      latestSubscriptionByAcademy.set(row.academyId, row);
    }
  }

  const latestUsageByAcademy = new Map<string, AcademyUsageSnapshot>();
  for (const row of usageRows) {
    if (!latestUsageByAcademy.has(row.academyId)) {
      latestUsageByAcademy.set(row.academyId, toSnapshot(row));
    }
  }

  return academyRows.map((academy) => {
    const subscription = latestSubscriptionByAcademy.get(academy.id);
    return {
      academyId: academy.id,
      academyName: academy.name,
      planName: subscription?.planName ?? null,
      usage: latestUsageByAcademy.get(academy.id) ?? null,
      limits: subscription
        ? {
            maxBranches: subscription.maxBranches,
            maxStudents: subscription.maxStudents,
            maxStaff: subscription.maxStaff,
            maxCourses: subscription.maxCourses,
            maxStorageBytes: subscription.maxStorageBytes,
          }
        : null,
    };
  });
}

/** Used by the page/manager to gate rendering — see module comment above. */
export { USAGE_VIEW_CAPABILITY };
