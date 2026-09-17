import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { branches, staffBranchAssignments, staffProfiles } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_STAFF_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md Phase 2, Item 36 — "Staff branch assignment (many-to-many) +
 * branch-scoped filter + IDOR test."
 *
 * `staff_branch_assignments` itself (id, academy_id, staff_profile_id FK
 * staff_profiles, branch_id FK branches, created_at; unique
 * (staff_profile_id, branch_id)) was already created by Item 33 — no schema
 * change here.
 *
 * Gating: assigning a staff member's branches is a staff-management action,
 * not a separate Master Permission Matrix row of its own — this reuses the
 * existing `"academy.staff"` row (Owner/Admin = full, Manager = manage,
 * Trainer = view) via `getAcademyPermissionLevel`/`ACADEMY_STAFF_ACTION`,
 * gated at manage/full, the exact same level lib/academies/staff.ts's
 * `updateStaff` already requires. No new lib/auth/academy-permissions.ts
 * row is added or needed for this item.
 */

const MANAGE_LEVELS: ReadonlySet<AcademyPermissionLevel> = new Set(["full", "manage"]);

function canManageStaff(level: AcademyPermissionLevel): boolean {
  return MANAGE_LEVELS.has(level);
}

export interface StaffBranchActionError {
  code: "forbidden" | "validation" | "blocked" | "not_found";
  message: string;
}

const FORBIDDEN: StaffBranchActionError = {
  code: "forbidden",
  message: "You don't have permission to manage this academy's staff branch assignments.",
};

// Same IDOR-safety convention as lib/academies/staff.ts's updateStaff and
// lib/academies/branches.ts's NOT_FOUND: a staffProfileId belonging to
// another academy (or that doesn't exist at all) must be indistinguishable
// from a legitimate id the caller simply isn't allowed to touch —
// including via a guessed id — so both cases return this same shape.
const NOT_FOUND: StaffBranchActionError = {
  code: "not_found",
  message: "Staff member not found.",
};

const branchIdsSchema = z.array(z.string().uuid()).max(500);

/**
 * Shared read helper: every branch_id currently assigned to a given
 * staff_profiles row. Takes a `DbClient` (plain `db` or a transaction's
 * `tx`) so `assignStaffBranches` can read the pre-change set from inside
 * its own transaction, same seam `recordAudit` itself uses.
 */
async function getBranchIdsForStaffProfile(
  executor: DbClient,
  staffProfileId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ branchId: staffBranchAssignments.branchId })
    .from(staffBranchAssignments)
    .where(eq(staffBranchAssignments.staffProfileId, staffProfileId));
  return rows.map((row) => row.branchId);
}

export type ListAssignedBranchesResult =
  | { ok: true; branchIds: string[] }
  | { ok: false; error: StaffBranchActionError };

/**
 * Read counterpart to `assignStaffBranches` — the current branch set for a
 * staff member, e.g. to prefill an edit form. Gated identically (manage/
 * full on `academy.staff`) and tenant-scoped the same way: a staffProfileId
 * outside the caller's own academy returns the same `not_found` a guessed
 * id would.
 */
export async function listAssignedBranches(
  actorContext: AuthContext,
  staffProfileId: string,
): Promise<ListAssignedBranchesResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (!canManageStaff(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(staffProfileId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [staff] = await db
    .select({ id: staffProfiles.id })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.id, staffProfileId), eq(staffProfiles.academyId, access.academyId)))
    .limit(1);
  if (!staff) {
    return { ok: false, error: NOT_FOUND };
  }

  return { ok: true, branchIds: await getBranchIdsForStaffProfile(db, staff.id) };
}

export type AssignStaffBranchesResult =
  | { ok: true; branchIds: string[] }
  | { ok: false; error: StaffBranchActionError };

type TransactionOutcome =
  | { kind: "ok"; branchIds: string[] }
  | { kind: "not_found" }
  | { kind: "validation" };

/**
 * PLAN.md §4: `assignStaffBranches` — replaces a staff member's *entire*
 * set of branch assignments in one call (diff against the existing
 * `staff_branch_assignments` rows, then insert what's new and delete what's
 * gone), the same "resubmit the whole set" convention `updateStaff` already
 * uses for the employment-record fields rather than a per-branch add/remove
 * pair of actions.
 *
 * Tenant-scoped + IDOR-safe on both sides of the relationship: the target
 * `staffProfileId` must belong to the actor's own academy (else `not_found`,
 * never a distinguishing `forbidden`), and every `branchId` in the desired
 * set must also belong to that same academy (else `validation` — a bogus or
 * cross-tenant branch id never silently gets attached). Duplicate ids in the
 * input are de-duplicated before diffing, since the unique
 * `(staff_profile_id, branch_id)` index would otherwise reject a
 * caller-supplied duplicate on insert.
 *
 * The lookup, diff, insert/delete, and audit write all happen inside one
 * transaction — same "a sensitive mutation cannot succeed if its audit
 * write fails" posture as every other mutation in this codebase.
 */
export async function assignStaffBranches(
  actorContext: AuthContext,
  staffProfileId: string,
  branchIds: string[],
): Promise<AssignStaffBranchesResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (!canManageStaff(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedStaffId = z.string().uuid().safeParse(staffProfileId);
  if (!parsedStaffId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsedBranchIds = branchIdsSchema.safeParse(branchIds);
  if (!parsedBranchIds.success) {
    return { ok: false, error: { code: "validation", message: "Invalid branch id." } };
  }
  const desiredBranchIds = Array.from(new Set(parsedBranchIds.data));

  const academyId = access.academyId;

  const result: TransactionOutcome = await db.transaction(async (tx) => {
    const [staff] = await tx
      .select({ id: staffProfiles.id })
      .from(staffProfiles)
      .where(and(eq(staffProfiles.id, staffProfileId), eq(staffProfiles.academyId, academyId)))
      .limit(1);
    if (!staff) {
      return { kind: "not_found" };
    }

    if (desiredBranchIds.length > 0) {
      const owned = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(inArray(branches.id, desiredBranchIds), eq(branches.academyId, academyId)));
      if (owned.length !== desiredBranchIds.length) {
        return { kind: "validation" };
      }
    }

    const existingBranchIds = await getBranchIdsForStaffProfile(tx, staffProfileId);

    const toAdd = desiredBranchIds.filter((id) => !existingBranchIds.includes(id));
    const toRemove = existingBranchIds.filter((id) => !desiredBranchIds.includes(id));

    if (toRemove.length > 0) {
      await tx
        .delete(staffBranchAssignments)
        .where(
          and(
            eq(staffBranchAssignments.staffProfileId, staffProfileId),
            inArray(staffBranchAssignments.branchId, toRemove),
          ),
        );
    }
    if (toAdd.length > 0) {
      await tx.insert(staffBranchAssignments).values(
        toAdd.map((branchId) => ({ academyId, staffProfileId, branchId })),
      );
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: access.membershipRole,
        academyId,
        action: "assignStaffBranches",
        entityType: "staff_profile",
        entityId: staffProfileId,
        before: { branchIds: existingBranchIds },
        after: { branchIds: desiredBranchIds },
      },
      tx,
    );

    return { kind: "ok", branchIds: desiredBranchIds };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: NOT_FOUND };
  }
  if (result.kind === "validation") {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "One or more branches were not found in this academy.",
      },
    };
  }
  return { ok: true, branchIds: result.branchIds };
}
