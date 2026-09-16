import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  academyUsage,
  branches,
  subscriptionPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  computeLazySubscriptionStatus,
  type SubscriptionStatus,
} from "@/lib/subscriptions/state-machine";

/**
 * PLAN.md Phase 1, Item 21 (shell scope — see app/platform/academies/*
 * comments for exactly what's deferred to later items): `approveAcademy`
 * sets `academies.approved_by`/`approved_at`. "approveAcademy" is already
 * in UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts), so hasPermission()
 * returns true here only for platform_owner — no platform_admin grant can
 * ever satisfy it.
 */
const APPROVE_CAPABILITY = "approveAcademy";

export interface ApproveAcademyError {
  code: "forbidden" | "validation" | "not_found" | "already_approved";
  message: string;
}

const FORBIDDEN: ApproveAcademyError = {
  code: "forbidden",
  message: "You don't have permission to approve academies.",
};

const approveAcademyInputSchema = z.object({
  academyId: z.string().uuid("Invalid academy id."),
});

/**
 * Lifecycle state is deliberately derived, never stored (schema.ts's
 * comment on the `academies` table, Decision #1): pending-approval =
 * approved_at IS NULL, approved = approved_at IS NOT NULL, closed =
 * closed_at IS NOT NULL (closed_at overrides — no closeAcademy action
 * exists yet to set it, but the column already does, so this stays
 * defensive rather than assuming it's always null).
 */
export type AcademyLifecycleStatus = "pending_approval" | "approved" | "closed";

export function deriveAcademyStatus(row: {
  approvedAt: Date | null;
  closedAt: Date | null;
}): AcademyLifecycleStatus {
  if (row.closedAt) return "closed";
  if (row.approvedAt) return "approved";
  return "pending_approval";
}

export interface AcademySummary {
  id: string;
  name: string;
  slug: string;
  type: string | null;
  defaultCurrency: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoRef: string | null;
  registrationNumber: string | null;
  primaryContactName: string | null;
  primaryContactPhone: string | null;
  createdBy: string;
  createdByEmail: string | null;
  approvedBy: string | null;
  approvedByEmail: string | null;
  approvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  status: AcademyLifecycleStatus;
  /**
   * DESIGN.md §8's /platform/academies column list ("plan, branch count,
   * student count") plus §11.1's derived subscription badge — added onto
   * AcademySummary (rather than a second parallel type) so listAcademies()
   * and getAcademyById() share one shape, same as every other field here.
   * null/0 for an academy that has no academy_subscriptions row at all
   * (possible for rows inserted directly rather than through
   * registerAcademy, e.g. this file's own test helpers) — never faked.
   */
  planName: string | null;
  /**
   * The *effective* status (computeLazySubscriptionStatus — lib/subscriptions/
   * state-machine.ts), not the raw stored column: DESIGN.md §11.1's badge
   * table is explicit that Past-Due-past-grace and Trial-past-trial-end must
   * display as Suspended/Expired even before any write has lazily persisted
   * that flip. Display-only; lifecycle-actions.tsx gates its buttons off the
   * raw stored status instead (see that file's own comment for why).
   */
  subscriptionStatus: SubscriptionStatus | null;
  /** Active branches only, matching lib/subscriptions/usage.ts's countActiveBranches. */
  branchCount: number;
  /**
   * DESIGN.md §8 also wants a student-count column. No `students` table
   * exists anywhere in this codebase yet (Phase 2+, same gap
   * lib/subscriptions/usage.ts's countActiveStudents documents) — there is
   * deliberately no `studentCount` field here. Rendering a 0 or omitting the
   * column entirely at the call site is a UI decision, not a data one; this
   * type simply never invents a number for something that can't be counted.
   */
}

type AcademyRow = typeof academies.$inferSelect;

interface SubscriptionSummaryInfo {
  planName: string | null;
  subscriptionStatus: SubscriptionStatus | null;
}

function toSummary(
  row: AcademyRow,
  info: {
    createdByEmail: string | null;
    approvedByEmail: string | null;
    subscription: SubscriptionSummaryInfo;
    branchCount: number;
  },
): AcademySummary {
  const { subscription, branchCount, ...emails } = info;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    defaultCurrency: row.defaultCurrency,
    address: row.address,
    phone: row.phone,
    email: row.email,
    website: row.website,
    logoRef: row.logoRef,
    registrationNumber: row.registrationNumber,
    primaryContactName: row.primaryContactName,
    primaryContactPhone: row.primaryContactPhone,
    createdBy: row.createdBy,
    createdByEmail: emails.createdByEmail,
    approvedBy: row.approvedBy,
    approvedByEmail: emails.approvedByEmail,
    approvedAt: row.approvedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    status: deriveAcademyStatus(row),
    planName: subscription.planName,
    subscriptionStatus: subscription.subscriptionStatus,
    branchCount,
  };
}

/**
 * Batch helper shared by listAcademies()/getAcademyById(): for every academy
 * id given, the plan name + effective subscription status of its *current*
 * subscription (most-recently-started row — same "no is-current flag, latest
 * starts_at wins" convention as lib/academies/lifecycle.ts's
 * getCurrentSubscription and lib/academies/access-gate.ts's checkAcademyAccess).
 * An academy with no academy_subscriptions row at all (only possible for a
 * row inserted outside registerAcademy, e.g. this file's own tests) maps to
 * { planName: null, subscriptionStatus: null } rather than throwing.
 */
async function getLatestSubscriptionSummaries(
  academyIds: string[],
  executor: DbClient = db,
): Promise<Map<string, SubscriptionSummaryInfo>> {
  const result = new Map<string, SubscriptionSummaryInfo>();
  if (academyIds.length === 0) return result;

  const rows = await executor
    .select({
      academyId: academySubscriptions.academyId,
      status: academySubscriptions.status,
      startsAt: academySubscriptions.startsAt,
      endsAt: academySubscriptions.endsAt,
      trialEndsAt: academySubscriptions.trialEndsAt,
      planName: subscriptionPlans.name,
    })
    .from(academySubscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
    .where(inArray(academySubscriptions.academyId, academyIds))
    .orderBy(desc(academySubscriptions.startsAt));

  for (const row of rows) {
    if (result.has(row.academyId)) continue; // first row per academy = latest, thanks to the ORDER BY above
    result.set(row.academyId, {
      planName: row.planName,
      subscriptionStatus: computeLazySubscriptionStatus({
        status: row.status,
        trialEndsAt: row.trialEndsAt,
        endsAt: row.endsAt,
      }),
    });
  }
  return result;
}

/**
 * Batch helper shared by listAcademies()/getAcademyById(): active-branch
 * count per academy id, matching lib/subscriptions/usage.ts's
 * countActiveBranches (active branches only — an archived branch isn't part
 * of an academy's operating footprint).
 */
async function getBranchCounts(
  academyIds: string[],
  executor: DbClient = db,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (academyIds.length === 0) return result;

  const rows = await executor
    .select({
      academyId: branches.academyId,
      count: sql<number>`count(*)::int`,
    })
    .from(branches)
    .where(and(inArray(branches.academyId, academyIds), eq(branches.status, "active")))
    .groupBy(branches.academyId);

  for (const row of rows) {
    result.set(row.academyId, row.count);
  }
  return result;
}

const NO_SUBSCRIPTION_SUMMARY: SubscriptionSummaryInfo = {
  planName: null,
  subscriptionStatus: null,
};

/**
 * Lists every academy for /platform/academies, newest first. Callers must
 * already have checked hasPermission() themselves (matches
 * listPlatformStaff()'s convention in lib/platform-staff/staff.ts — this
 * helper does not re-check).
 */
export async function listAcademies(): Promise<AcademySummary[]> {
  const rows = await db
    .select({
      academy: academies,
      createdByEmail: users.email,
    })
    .from(academies)
    .innerJoin(users, eq(users.id, academies.createdBy))
    .orderBy(desc(academies.createdAt));

  // approvedBy is nullable, so it can't share the innerJoin above — a
  // second lookup keyed by id is simpler than a conditional join clause.
  const approvedByIds = rows
    .map((row) => row.academy.approvedBy)
    .filter((id): id is string => id !== null);

  const approverEmailById = new Map<string, string>();
  if (approvedByIds.length > 0) {
    const approverRows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, approvedByIds));
    for (const approver of approverRows) {
      approverEmailById.set(approver.id, approver.email);
    }
  }

  const academyIds = rows.map((row) => row.academy.id);
  const [subscriptionByAcademy, branchCountByAcademy] = await Promise.all([
    getLatestSubscriptionSummaries(academyIds),
    getBranchCounts(academyIds),
  ]);

  return rows.map(({ academy, createdByEmail }) =>
    toSummary(academy, {
      createdByEmail,
      approvedByEmail: academy.approvedBy
        ? (approverEmailById.get(academy.approvedBy) ?? null)
        : null,
      subscription: subscriptionByAcademy.get(academy.id) ?? NO_SUBSCRIPTION_SUMMARY,
      branchCount: branchCountByAcademy.get(academy.id) ?? 0,
    }),
  );
}

/**
 * Fetches a single academy for /platform/academies/[id]. Returns null for
 * a missing or malformed id (page renders a calm "not found" state either
 * way) rather than throwing. Callers must already have checked
 * hasPermission() themselves, same convention as listAcademies() above.
 */
export async function getAcademyById(
  academyId: string,
): Promise<AcademySummary | null> {
  const parsed = z.string().uuid().safeParse(academyId);
  if (!parsed.success) return null;

  const [row] = await db
    .select()
    .from(academies)
    .where(eq(academies.id, parsed.data))
    .limit(1);
  if (!row) return null;

  const [creator] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.createdBy))
    .limit(1);

  let approvedByEmail: string | null = null;
  if (row.approvedBy) {
    const [approver] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, row.approvedBy))
      .limit(1);
    approvedByEmail = approver?.email ?? null;
  }

  const [subscriptionByAcademy, branchCountByAcademy] = await Promise.all([
    getLatestSubscriptionSummaries([row.id]),
    getBranchCounts([row.id]),
  ]);

  return toSummary(row, {
    createdByEmail: creator?.email ?? null,
    approvedByEmail,
    subscription: subscriptionByAcademy.get(row.id) ?? NO_SUBSCRIPTION_SUMMARY,
    branchCount: branchCountByAcademy.get(row.id) ?? 0,
  });
}

export type ApproveAcademyResult =
  | { ok: true; academy: AcademySummary }
  | { ok: false; error: ApproveAcademyError };

/**
 * Sets academies.approved_by/approved_at (PLAN.md Phase 1 §2/§4). Gated so
 * only platform_owner can ever call it — enforced via hasPermission()
 * against the ungrantable "approveAcademy" capability, not a role check
 * here directly, matching every other mutation in this codebase (see
 * requireStaffManagePermission in lib/platform-staff/staff.ts).
 *
 * Deliberately NOT implemented here (PLAN.md Items 22-26, not yet built):
 * any onboarding-checklist precondition (plan selected/payment verified),
 * gating on `getOnboardingChecklistStatus`, or a rejection path (PLAN.md
 * Phase 1 §4 explicitly says rejection reuses `cancelAcademy`, Item 26 —
 * this action only ever sets approved_by/approved_at, never a rejected
 * state, because no such state exists on this schema).
 */
export async function approveAcademy(
  actorContext: AuthContext,
  academyId: string,
): Promise<ApproveAcademyResult> {
  const allowed = await hasPermission(actorContext, APPROVE_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = approveAcademyInputSchema.safeParse({ academyId });
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: academies.id, approvedAt: academies.approvedAt })
      .from(academies)
      .where(eq(academies.id, parsed.data.academyId))
      .limit(1);

    if (!existing) {
      return {
        ok: false,
        error: { code: "not_found", message: "Academy not found." },
      } as const;
    }
    if (existing.approvedAt) {
      return {
        ok: false,
        error: {
          code: "already_approved",
          message: "This academy has already been approved.",
        },
      } as const;
    }

    // The `approvedAt IS NULL` clause here (not just the select above)
    // closes the race between two concurrent approveAcademy calls — only
    // one of them can ever be the row that flips a non-null approved_at.
    const [updated] = await tx
      .update(academies)
      .set({ approvedBy: actorContext.userId, approvedAt: new Date() })
      .where(
        and(eq(academies.id, parsed.data.academyId), isNull(academies.approvedAt)),
      )
      .returning();

    if (!updated) {
      return {
        ok: false,
        error: {
          code: "already_approved",
          message: "This academy has already been approved.",
        },
      } as const;
    }

    // Same-transaction audit write (Cross-Cutting Architecture Decisions:
    // "a sensitive mutation cannot succeed if its audit write fails").
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: updated.id,
        action: "approveAcademy",
        entityType: "academy",
        entityId: updated.id,
        before: { approvedAt: null, approvedBy: null },
        after: { approvedAt: updated.approvedAt, approvedBy: updated.approvedBy },
      },
      tx,
    );

    const [creator] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, updated.createdBy))
      .limit(1);
    const [approver] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, actorContext.userId))
      .limit(1);

    // approveAcademy only ever changes approved_by/approved_at — plan/branch
    // info can't have changed within this same transaction, but re-fetching
    // via the shared batch helpers (rather than duplicating their queries
    // inline) keeps this the one place that assembles a full AcademySummary.
    const [subscriptionByAcademy, branchCountByAcademy] = await Promise.all([
      getLatestSubscriptionSummaries([updated.id], tx),
      getBranchCounts([updated.id], tx),
    ]);

    return {
      ok: true,
      academy: toSummary(updated, {
        createdByEmail: creator?.email ?? null,
        approvedByEmail: approver?.email ?? null,
        subscription: subscriptionByAcademy.get(updated.id) ?? NO_SUBSCRIPTION_SUMMARY,
        branchCount: branchCountByAcademy.get(updated.id) ?? 0,
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Read-only helpers for /platform/academies/[id]'s Subscription & Plan,
// Usage vs. Allowances, and Payment History sections (PLAN.md Item 21's
// detail-page scope). These deliberately live here rather than in
// lib/subscriptions/* (off-limits this wave — see this item's task brief):
// each queries subscriptionPayments/academySubscriptions/subscriptionPlans/
// academyUsage directly for exactly one academy, instead of reusing
// lib/subscriptions/payments.ts's listSubscriptionPayments() (all academies,
// no filter) or lib/subscriptions/usage.ts's listAcademyUsageOverview() (same
// issue) — both of which are read-only modules this item isn't allowed to
// modify to add a per-academy filter. Callers must already have checked
// hasPermission() themselves, same convention as every list/get helper above.
// ---------------------------------------------------------------------------

export interface AcademySubscriptionOverview {
  subscriptionId: string;
  planId: string;
  planName: string;
  priceAmountCents: number;
  currency: string;
  billingPeriod: string;
  /** Raw, stored status — what lifecycle-actions.tsx gates its buttons on. */
  status: SubscriptionStatus;
  /** Effective status (computeLazySubscriptionStatus) — what gets displayed. */
  effectiveStatus: SubscriptionStatus;
  startsAt: Date;
  endsAt: Date | null;
  trialEndsAt: Date | null;
  activatedAt: Date | null;
  suspendedAt: Date | null;
  cancelledAt: Date | null;
  renewedAt: Date | null;
  notes: string | null;
}

/**
 * The academy's *current* subscription (latest starts_at) joined to its
 * plan, for the detail page's read-only Subscription & Plan section. Returns
 * null when the academy has no academy_subscriptions row at all (see
 * getLatestSubscriptionSummaries's own comment on why that's possible).
 */
export async function getAcademySubscriptionOverview(
  academyId: string,
): Promise<AcademySubscriptionOverview | null> {
  const parsed = z.string().uuid().safeParse(academyId);
  if (!parsed.success) return null;

  const [row] = await db
    .select({
      subscriptionId: academySubscriptions.id,
      planId: academySubscriptions.planId,
      planName: subscriptionPlans.name,
      priceAmountCents: subscriptionPlans.priceAmountCents,
      currency: subscriptionPlans.currency,
      billingPeriod: subscriptionPlans.billingPeriod,
      status: academySubscriptions.status,
      startsAt: academySubscriptions.startsAt,
      endsAt: academySubscriptions.endsAt,
      trialEndsAt: academySubscriptions.trialEndsAt,
      activatedAt: academySubscriptions.activatedAt,
      suspendedAt: academySubscriptions.suspendedAt,
      cancelledAt: academySubscriptions.cancelledAt,
      renewedAt: academySubscriptions.renewedAt,
      notes: academySubscriptions.notes,
    })
    .from(academySubscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
    .where(eq(academySubscriptions.academyId, parsed.data))
    .orderBy(desc(academySubscriptions.startsAt))
    .limit(1);

  if (!row) return null;

  return {
    ...row,
    effectiveStatus: computeLazySubscriptionStatus({
      status: row.status,
      trialEndsAt: row.trialEndsAt,
      endsAt: row.endsAt,
    }),
  };
}

export interface AcademyPaymentHistoryRow {
  id: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
  paymentReference: string | null;
  evidenceFileRef: string | null;
  receivedAt: Date;
  recordedByEmail: string | null;
  verifiedByEmail: string | null;
  status: "pending" | "verified" | "rejected" | "reversed";
  notes: string | null;
  createdAt: Date;
}

/**
 * Every subscription_payments row for one academy, newest first, for the
 * detail page's read-only Payment History section. Read-only display only —
 * no Verify/Reject/Reverse row actions here, those stay on /platform/payments
 * (lib/subscriptions/payments.ts, off-limits this wave), matching this
 * item's brief for the Subscription tab being "read-only display only."
 */
export async function listAcademyPaymentHistory(
  academyId: string,
): Promise<AcademyPaymentHistoryRow[]> {
  const parsed = z.string().uuid().safeParse(academyId);
  if (!parsed.success) return [];

  const recordedByUsers = users;
  const verifiedByUsers = alias(users, "verified_by_users");

  const rows = await db
    .select({
      id: subscriptionPayments.id,
      amountCents: subscriptionPayments.amountCents,
      currency: subscriptionPayments.currency,
      paymentMethod: subscriptionPayments.paymentMethod,
      paymentReference: subscriptionPayments.paymentReference,
      evidenceFileRef: subscriptionPayments.evidenceFileRef,
      receivedAt: subscriptionPayments.receivedAt,
      recordedByEmail: recordedByUsers.email,
      verifiedByEmail: verifiedByUsers.email,
      status: subscriptionPayments.status,
      notes: subscriptionPayments.notes,
      createdAt: subscriptionPayments.createdAt,
    })
    .from(subscriptionPayments)
    .innerJoin(recordedByUsers, eq(recordedByUsers.id, subscriptionPayments.recordedBy))
    .leftJoin(verifiedByUsers, eq(verifiedByUsers.id, subscriptionPayments.verifiedBy))
    .where(eq(subscriptionPayments.academyId, parsed.data))
    .orderBy(desc(subscriptionPayments.createdAt));

  return rows;
}

export interface AcademyUsageSnapshotView {
  activeStudentsCount: number;
  activeStaffCount: number;
  branchCount: number;
  courseCount: number;
  storageUsedBytes: number;
  calculatedAt: Date;
}

export interface AcademyUsageOverview {
  /** Null when recalculateUsage (lib/subscriptions/usage.ts) has never run for this academy. */
  usage: AcademyUsageSnapshotView | null;
  /** Null when the academy has no subscription/plan to compare usage against. */
  limits: {
    maxBranches: number;
    maxStudents: number;
    maxStaff: number;
    maxCourses: number;
    maxStorageBytes: number;
  } | null;
}

/**
 * The academy's latest academy_usage snapshot plus its current plan's
 * allowances, for the detail page's read-only Usage vs. Allowances section.
 * Deliberately queries academyUsage/subscriptionPlans directly for this one
 * academy rather than reusing lib/subscriptions/usage.ts's
 * listAcademyUsageOverview() (every academy, no per-academy filter, and that
 * file is off-limits this wave — see this section's top-of-file comment).
 */
export async function getAcademyUsageOverview(
  academyId: string,
): Promise<AcademyUsageOverview> {
  const parsed = z.string().uuid().safeParse(academyId);
  if (!parsed.success) return { usage: null, limits: null };

  const [usageRow] = await db
    .select({
      activeStudentsCount: academyUsage.activeStudentsCount,
      activeStaffCount: academyUsage.activeStaffCount,
      branchCount: academyUsage.branchCount,
      courseCount: academyUsage.courseCount,
      storageUsedBytes: academyUsage.storageUsedBytes,
      calculatedAt: academyUsage.calculatedAt,
    })
    .from(academyUsage)
    .where(eq(academyUsage.academyId, parsed.data))
    .orderBy(desc(academyUsage.calculatedAt))
    .limit(1);

  const [planRow] = await db
    .select({
      maxBranches: subscriptionPlans.maxBranches,
      maxStudents: subscriptionPlans.maxStudents,
      maxStaff: subscriptionPlans.maxStaff,
      maxCourses: subscriptionPlans.maxCourses,
      maxStorageBytes: subscriptionPlans.maxStorageBytes,
    })
    .from(academySubscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
    .where(eq(academySubscriptions.academyId, parsed.data))
    .orderBy(desc(academySubscriptions.startsAt))
    .limit(1);

  return {
    usage: usageRow ?? null,
    limits: planRow ?? null,
  };
}
