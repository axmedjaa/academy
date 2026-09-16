import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { branches, staffBranchAssignments, staffProfiles } from "@/lib/db/schema";
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
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict" | "allowance";
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
  | { ok: true; branches: BranchRecord[]; permissionLevel: AcademyPermissionLevel; canManage: boolean }
  | { ok: false; error: BranchActionError };

/**
 * `/academy/branches`'s list read. Academy-wide roles (full/manage) get
 * every branch in the academy; branch-limited roles (view, per the matrix's
 * "assigned" scope) get only the branches they're assigned to via
 * staff_branch_assignments.
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

  return {
    ok: true,
    branches: rows.map(toRecord),
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
