import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { auditLogs, batches, branches, staffBranchAssignments, staffProfiles, students, timetables } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { checkAllowance, type UsageActionError } from "@/lib/subscriptions/usage";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 2, Item 34 — "Branch CRUD (`/academy/branches`) +
 * `checkAllowance('branches')`."
 *
 * Gating follows lib/academies/settings.ts's (Item 41) exact template:
 * resolve academy+role via `checkAcademyAccessForContext` (never a
 * client-supplied academyId), then consult
 * lib/auth/academy-permissions.ts for the row this item adds
 * (`"academy.branches"`). Master Permission Matrix "Branches" row:
 * Full(owner)/Full(admin)/Manage(manager)/View(admissions_officer)/
 * none(finance_officer)/View(trainer), scope "assigned" for the two
 * branch-limited roles.
 *
 * "full" and "manage" are both create/edit/archive-capable (matches
 * PLAN.md §4's "createBranch/updateBranch/archiveBranch" with no
 * Full-vs-Manage distinction called out); "view" (Admissions Officer,
 * Trainer) may only list/read, and only their own assigned branch(es)
 * (§6: "further by branch_id for branch-limited roles ... Admissions
 * Officer, Trainer"); "none" (Finance Officer) is refused entirely, same
 * as every "—" cell elsewhere in this codebase's academy-permission gates.
 */
export const ACADEMY_BRANCHES_ACTION = "academy.branches";

// PLAN.md §6: "further by branch_id for branch-limited roles (Admissions
// Officer, Trainer) — academy-wide roles (Academy Owner, Academy
// Administrator, Manager, Finance Officer) skip the branch filter by
// design, not by accident." Finance Officer has no access to this row at
// all (permission level "none"), so it never reaches the branch-filter
// question, but is listed in PLAN.md's academy-wide group for
// completeness/consistency with that section's own wording.
const BRANCH_LIMITED_ROLES: ReadonlySet<AcademyRole> = new Set([
  "admissions_officer",
  "trainer",
]);

function isBranchLimited(role: AcademyRole): boolean {
  return BRANCH_LIMITED_ROLES.has(role);
}

function canManage(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

export interface BranchActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict" | "allowance" | "ineligible";
  message: string;
}

const FORBIDDEN: BranchActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's branches.",
};

// Same generic-message IDOR-safety convention as
// lib/academies/access-gate.ts's NOT_A_MEMBER: "doesn't exist" and
// "exists but you can't see it" (wrong academy, or a branch-limited role
// hitting an unassigned branch) must be indistinguishable to the caller,
// including via a guessed id.
const NOT_FOUND: BranchActionError = {
  code: "not_found",
  message: "Branch not found.",
};

function optionalText(maxLength = 500) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

export const createBranchSchema = z.object({
  name: z.string().trim().min(1, "Branch name is required").max(200),
  code: z.string().trim().toUpperCase().min(1, "Branch code is required").max(30),
  address: optionalText(500),
  phone: optionalText(50),
});

// Full-object update, same convention as updateAcademySettings/
// updateSubscriptionPlan — one branch-profile form, not per-field PATCH.
export const updateBranchSchema = createBranchSchema;

export type CreateBranchInput = z.input<typeof createBranchSchema>;
export type UpdateBranchInput = z.input<typeof updateBranchSchema>;

export interface BranchRecord {
  id: string;
  academyId: string;
  name: string;
  code: string;
  status: "active" | "archived";
  address: string | null;
  phone: string | null;
  createdAt: Date;
}

function toRecord(row: typeof branches.$inferSelect): BranchRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    name: row.name,
    code: row.code,
    status: row.status,
    address: row.address,
    phone: row.phone,
    createdAt: row.createdAt,
  };
}

/**
 * Resolves the caller's staff_profiles row (by userId+academyId) and its
 * staff_branch_assignments, per the task brief: "join the caller's
 * staff_profiles row ... to staff_branch_assignments to get their
 * assigned branch_ids." A caller with no staff_profiles row (or a
 * profile with zero assignments) is assigned to nothing — an empty list,
 * not an error, so a branch-limited role with no assignments yet simply
 * sees no branches rather than every branch.
 */
async function getAssignedBranchIds(
  executor: DbClient,
  academyId: string,
  userId: string,
): Promise<string[]> {
  const [profile] = await executor
    .select({ id: staffProfiles.id })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, userId)))
    .limit(1);
  if (!profile) return [];

  const assignments = await executor
    .select({ branchId: staffBranchAssignments.branchId })
    .from(staffBranchAssignments)
    .where(eq(staffBranchAssignments.staffProfileId, profile.id));

  return assignments.map((row) => row.branchId);
}

interface ResolvedBranchAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveBranchAccessResult =
  | { ok: true; access: ResolvedBranchAccess }
  | { ok: false; error: BranchActionError };

async function resolveBranchAccess(
  actorContext: AuthContext,
): Promise<ResolveBranchAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(
    access.membershipRole,
    ACADEMY_BRANCHES_ACTION,
  );
  if (permissionLevel === "none") {
    return { ok: false, error: FORBIDDEN };
  }

  return {
    ok: true,
    access: {
      academyId: access.academyId,
      membershipRole: access.membershipRole,
      permissionLevel,
    },
  };
}

export type ListBranchesResult =
  | {
      ok: true;
      branches: (BranchRecord & { deletionEligibility: BranchDeletionEligibilitySummary })[];
      permissionLevel: AcademyPermissionLevel;
      canManage: boolean;
    }
  | { ok: false; error: BranchActionError };

/**
 * `/academy/branches`'s list read. Academy-wide roles (full/manage) get
 * every branch in the academy; branch-limited roles (view, per the matrix's
 * "assigned" scope) get only the branches they're assigned to via
 * staff_branch_assignments. Delete-eligibility is computed server-side
 * here (never in the UI) and handed down as plain data for the table's
 * Delete button to render.
 */
export async function listBranches(actorContext: AuthContext): Promise<ListBranchesResult> {
  const resolved = await resolveBranchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  let rows: (typeof branches.$inferSelect)[];
  if (isBranchLimited(membershipRole)) {
    const assignedIds = await getAssignedBranchIds(db, academyId, actorContext.userId);
    rows =
      assignedIds.length === 0
        ? []
        : await db
            .select()
            .from(branches)
            .where(and(eq(branches.academyId, academyId), inArray(branches.id, assignedIds)));
  } else {
    rows = await db.select().from(branches).where(eq(branches.academyId, academyId));
  }

  const branchIds = rows.map((row) => row.id);
  const [studentCountRows, batchCountRows] = branchIds.length
    ? await Promise.all([
        db
          .select({ branchId: students.branchId, count: sql<number>`count(*)::int` })
          .from(students)
          .where(inArray(students.branchId, branchIds))
          .groupBy(students.branchId),
        db
          .select({ branchId: batches.branchId, count: sql<number>`count(*)::int` })
          .from(batches)
          .where(inArray(batches.branchId, branchIds))
          .groupBy(batches.branchId),
      ])
    : [[], []];
  const studentCountByBranch = new Map(studentCountRows.map((r) => [r.branchId, r.count]));
  const batchCountByBranch = new Map(batchCountRows.map((r) => [r.branchId, r.count]));

  return {
    ok: true,
    branches: rows.map((row) => {
      const reasons = buildBranchDeletionReasons({
        studentCount: studentCountByBranch.get(row.id) ?? 0,
        batchCount: batchCountByBranch.get(row.id) ?? 0,
      });
      return { ...toRecord(row), deletionEligibility: { eligible: reasons.length === 0, reasons } };
    }),
    permissionLevel,
    canManage: canManage(permissionLevel),
  };
}

export type GetBranchResult =
  | { ok: true; branch: BranchRecord }
  | { ok: false; error: BranchActionError };

/**
 * Single-branch read, tenant- and (for branch-limited roles) branch-scoped.
 * IDOR-safe: a nonexistent id, a different academy's branch, and an
 * unassigned branch for a branch-limited caller all return the identical
 * `NOT_FOUND` — including for a guessed id — never a distinguishing
 * "forbidden" that would confirm the id exists.
 */
export async function getBranch(
  actorContext: AuthContext,
  branchId: string,
): Promise<GetBranchResult> {
  const resolved = await resolveBranchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const parsedId = z.string().uuid().safeParse(branchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [row] = await db
    .select()
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.academyId, academyId)))
    .limit(1);
  if (!row) {
    return { ok: false, error: NOT_FOUND };
  }

  if (isBranchLimited(membershipRole)) {
    const assignedIds = await getAssignedBranchIds(db, academyId, actorContext.userId);
    if (!assignedIds.includes(row.id)) {
      return { ok: false, error: NOT_FOUND };
    }
  }

  return { ok: true, branch: toRecord(row) };
}

/** Thrown from inside createBranch's transaction to short-circuit to the
 * "allowance" error branch, same pattern as register.ts's
 * SubscriptionCreationFailure. */
class AllowanceLimitReached extends Error {
  constructor(
    public readonly current: number,
    public readonly limit: number,
  ) {
    super("Branch allowance limit reached.");
  }
}

class AllowanceCheckFailure extends Error {
  constructor(public readonly usageError: UsageActionError) {
    super(usageError.message);
  }
}

/**
 * Postgres unique_violation (23505) detection for the `(academy_id, code)`
 * race — drizzle-orm wraps the raw `pg` DatabaseError in its own
 * `DrizzleQueryError`, so the `code` field lives on `err.cause`, not on
 * `err` itself; checked at both levels defensively rather than assuming
 * one specific wrapping depth.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

export type CreateBranchResult =
  | { ok: true; branch: BranchRecord }
  | { ok: false; error: BranchActionError };

/**
 * PLAN.md §4: `createBranch` — "each create call goes through
 * checkAllowance." Only "full"/"manage" (Owner/Admin/Manager) may create;
 * "view" (Admissions Officer, Trainer) is refused here even though it has
 * some access to this row, per the matrix's Full/Full/Manage/View split.
 * checkAllowance is called inside the same transaction as the insert
 * (usage.ts's own documented seam for this) so the limit check and the row
 * that would push the academy over it can never race against each other.
 */
export async function createBranch(
  actorContext: AuthContext,
  input: CreateBranchInput,
): Promise<CreateBranchResult> {
  const resolved = await resolveBranchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createBranchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const allowance = await checkAllowance(academyId, "branches", tx);
      if (!allowance.ok) {
        throw new AllowanceCheckFailure(allowance.error);
      }
      if (!allowance.result.allowed) {
        throw new AllowanceLimitReached(allowance.result.current, allowance.result.limit);
      }

      const [row] = await tx
        .insert(branches)
        .values({
          academyId,
          name: data.name,
          code: data.code,
          address: data.address,
          phone: data.phone,
        })
        .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "createBranch",
          entityType: "branch",
          entityId: row.id,
          branchId: row.id,
          after: toRecord(row),
        },
        tx,
      );

      return row;
    });

    return { ok: true, branch: toRecord(result) };
  } catch (err) {
    if (err instanceof AllowanceLimitReached) {
      return {
        ok: false,
        error: {
          code: "allowance",
          message: `This academy has reached its plan's branch limit (${err.current}/${err.limit}). Archive an existing branch or upgrade the plan to add another.`,
        },
      };
    }
    if (err instanceof AllowanceCheckFailure) {
      return { ok: false, error: { code: "validation", message: err.usageError.message } };
    }
    // Final guard against a race on branches' (academy_id, code) unique
    // index between two concurrent creates — same 23505 handling as
    // register.ts.
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "A branch with that code already exists for this academy." },
      };
    }
    throw err;
  }
}

export type UpdateBranchResult =
  | { ok: true; branch: BranchRecord }
  | { ok: false; error: BranchActionError };

/**
 * PLAN.md §4: `updateBranch`. Same "full"/"manage" gate as createBranch —
 * update is not a capped-resource action, so no checkAllowance call.
 * Scoped to the caller's own academy (never a client-supplied academyId
 * beyond the branchId lookup itself); branch-limited roles never reach
 * this far since their permission level is "view", not "full"/"manage".
 */
export async function updateBranch(
  actorContext: AuthContext,
  branchId: string,
  input: UpdateBranchInput,
): Promise<UpdateBranchResult> {
  const resolved = await resolveBranchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(branchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsed = updateBranchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(branches)
        .where(and(eq(branches.id, branchId), eq(branches.academyId, academyId)))
        .limit(1);
      if (!existing) return null;

      const [updated] = await tx
        .update(branches)
        .set({
          name: data.name,
          code: data.code,
          address: data.address,
          phone: data.phone,
        })
        .where(eq(branches.id, branchId))
        .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "updateBranch",
          entityType: "branch",
          entityId: branchId,
          branchId,
          before: toRecord(existing),
          after: toRecord(updated),
        },
        tx,
      );

      return updated;
    });

    if (!result) {
      return { ok: false, error: NOT_FOUND };
    }
    return { ok: true, branch: toRecord(result) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "A branch with that code already exists for this academy." },
      };
    }
    throw err;
  }
}

export type ArchiveBranchResult =
  | { ok: true; branch: BranchRecord }
  | { ok: false; error: BranchActionError };

/**
 * PLAN.md §4: `archiveBranch` — no hard delete, `status = archived` is the
 * only removal path. Frees the branch allowance slot: checkAllowance's
 * `countActiveBranches` counter (lib/subscriptions/usage.ts) filters on
 * `status = "active"`, so an archived branch simply stops being counted —
 * no separate bookkeeping needed here beyond flipping the status column.
 *
 * Judgment call / deviation: PLAN.md's Archive & Deactivation Rules table
 * (out of this item's authorized read scope — not read here) is referenced
 * only secondhand via this item's own brief, which does not ask for a
 * "blocked while active staff/students are assigned" guard, and the
 * features that would make such a guard meaningful (staff assignment —
 * Item 36 — and student registration — Item 38) are explicitly called out
 * as not yet built this phase. Archiving here is therefore unconditional
 * (idempotent: archiving an already-archived branch is a no-op re-write),
 * matching only what §4/§6 of this item's brief actually specify.
 */
export async function archiveBranch(
  actorContext: AuthContext,
  branchId: string,
): Promise<ArchiveBranchResult> {
  const resolved = await resolveBranchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(branchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.academyId, academyId)))
      .limit(1);
    if (!existing) return null;

    const [updated] = await tx
      .update(branches)
      .set({ status: "archived" })
      .where(eq(branches.id, branchId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "archiveBranch",
        entityType: "branch",
        entityId: branchId,
        branchId,
        before: toRecord(existing),
        after: toRecord(updated),
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return { ok: false, error: NOT_FOUND };
  }
  return { ok: true, branch: toRecord(result) };
}

/**
 * ---------------------------------------------------------------------
 * Permanent branch deletion — narrow, eligibility-gated, distinct from
 * archiveBranch
 * ---------------------------------------------------------------------
 * Direct inbound FKs to `branches` (lib/db/schema.ts): staffBranchAssignments,
 * students.branch_id (NOT NULL), batches.branch_id (NOT NULL),
 * timetables.branch_id (NOT NULL). A student or batch ever having existed
 * under this branch is real operational/historical fact — either one
 * blocks deletion outright, matching this codebase's other entity-delete
 * functions' "any row blocks" convention (and transitively guaranteeing no
 * enrollment/exam/certificate/financial history is ever reachable from
 * this deletion, since all of those hang off a student or a batch).
 *
 * staffBranchAssignments and timetables are treated as safely disposable —
 * pure assignment/scheduling metadata with no standalone value once the
 * branch itself is gone, same judgment lib/academies/delete-academy.ts's
 * own disposable-data list already made for both at the whole-academy
 * scale.
 */
export interface BranchDeletionEligibilitySummary {
  eligible: boolean;
  reasons: string[];
}

export interface BranchDeletionEligibility extends BranchDeletionEligibilitySummary {
  branchId: string;
  branchName: string;
  studentCount: number;
  batchCount: number;
}

export type GetBranchDeletionEligibilityResult =
  | { ok: true; eligibility: BranchDeletionEligibility }
  | { ok: false; error: BranchActionError };

async function countBranchDependents(
  executor: DbClient,
  branchId: string,
): Promise<{ studentCount: number; batchCount: number }> {
  const [[studentRow], [batchRow]] = await Promise.all([
    executor.select({ count: sql<number>`count(*)::int` }).from(students).where(eq(students.branchId, branchId)),
    executor.select({ count: sql<number>`count(*)::int` }).from(batches).where(eq(batches.branchId, branchId)),
  ]);
  return { studentCount: studentRow?.count ?? 0, batchCount: batchRow?.count ?? 0 };
}

function buildBranchDeletionReasons(counts: { studentCount: number; batchCount: number }): string[] {
  const reasons: string[] = [];
  if (counts.studentCount > 0) {
    reasons.push(`${counts.studentCount} student${counts.studentCount === 1 ? "" : "s"} belong to this branch`);
  }
  if (counts.batchCount > 0) {
    reasons.push(`${counts.batchCount} batch${counts.batchCount === 1 ? "" : "es"} belong to this branch`);
  }
  return reasons;
}

/** Read-only preview for the UI's Delete button — `deleteBranch` below
 * re-runs the identical check itself, inside the deletion transaction, as
 * the actual authority. */
export async function getBranchDeletionEligibility(
  actorContext: AuthContext,
  branchId: string,
): Promise<GetBranchDeletionEligibilityResult> {
  const resolved = await resolveBranchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(branchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [branch] = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.academyId, academyId)))
    .limit(1);
  if (!branch) {
    return { ok: false, error: NOT_FOUND };
  }

  const counts = await countBranchDependents(db, branch.id);
  const reasons = buildBranchDeletionReasons(counts);

  return {
    ok: true,
    eligibility: { branchId: branch.id, branchName: branch.name, eligible: reasons.length === 0, reasons, ...counts },
  };
}

export type DeleteBranchResult =
  | { ok: true; branchId: string }
  | { ok: false; error: BranchActionError };

/**
 * Eligibility is re-verified from scratch INSIDE this transaction, on a
 * row locked with `for("update")` — a student could be registered or a
 * batch created against this branch between the UI's preview and this
 * call, and this is the check that actually decides whether the delete
 * proceeds. `confirmedName` must equal the branch's exact current name,
 * re-checked here (not just a UI affordance), same convention as
 * lib/academies/delete-academy.ts's deleteAcademy. Audited before the row
 * is removed, same convention as this codebase's other entity-delete
 * functions.
 */
export async function deleteBranch(
  actorContext: AuthContext,
  branchId: string,
  confirmedName: string,
): Promise<DeleteBranchResult> {
  const resolved = await resolveBranchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(branchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.academyId, academyId)))
      .for("update");
    if (!existing) {
      return { ok: false, error: NOT_FOUND };
    }

    if (confirmedName !== existing.name) {
      return {
        ok: false,
        error: { code: "validation", message: "Type the exact branch name to confirm permanent deletion." },
      };
    }

    const counts = await countBranchDependents(tx, existing.id);
    const reasons = buildBranchDeletionReasons(counts);
    if (reasons.length > 0) {
      return {
        ok: false,
        error: {
          code: "ineligible",
          message: `This branch cannot be permanently deleted because ${reasons.join(", ")}. Archive it instead.`,
        },
      };
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "deleteBranch",
        entityType: "branch",
        entityId: branchId,
        branchId,
        before: toRecord(existing),
      },
      tx,
    );

    // Disposable dependent data only — guaranteed by the eligibility check
    // above that no student/batch was ever attached to this branch.
    await tx.delete(staffBranchAssignments).where(eq(staffBranchAssignments.branchId, branchId));
    await tx.delete(timetables).where(eq(timetables.branchId, branchId));

    // Preserve every historical audit row that ever referenced this branch
    // (including the "deleteBranch" row just inserted above) by detaching
    // the FK rather than deleting them — same convention as
    // lib/academies/delete-academy.ts's deleteAcademy for
    // auditLogs.academyId. auditLogs.branchId is nullable specifically for
    // this; without this step the branches row below would violate
    // audit_logs' own FK constraint.
    await tx.update(auditLogs).set({ branchId: null }).where(eq(auditLogs.branchId, branchId));

    await tx.delete(branches).where(eq(branches.id, branchId));

    return { ok: true, branchId };
  });
}
