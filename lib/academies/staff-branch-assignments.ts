import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { academyMemberships, branches, staffBranchAssignments, staffProfiles } from "@/lib/db/schema";
import { getAssignedBranchIds } from "@/lib/academies/branch-access";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_STAFF_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

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

/** Multi-branch: a member without all-branch access may only add or remove
 * branches they themselves are assigned to. */
const OUT_OF_SCOPE: StaffBranchActionError = {
  code: "forbidden",
  message: "You can only change branches you work in, for staff who already work in one of them.",
};

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

/** The caller, as resolved by the access gate — what the in-transaction
 * helpers below need to apply the same rules for every entry point. */
interface Actor {
  userId: string;
  academyId: string;
  membershipRole: AcademyRole;
  academyWide: boolean;
}

const OWNER_ONLY_ALL_BRANCHES: StaffBranchActionError = {
  code: "forbidden",
  message: "Only the academy owner can grant or remove access to all branches.",
};

type ReplaceOutcome =
  | { kind: "ok"; branchIds: string[] }
  | { kind: "not_found" }
  | { kind: "validation" }
  | { kind: "archived_branch" }
  | { kind: "out_of_scope" }
  | { kind: "owner_only" }
  | { kind: "last_branch" };

function replaceOutcomeError(kind: Exclude<ReplaceOutcome["kind"], "ok">): StaffBranchActionError {
  switch (kind) {
    case "not_found":
      return NOT_FOUND;
    case "out_of_scope":
      return OUT_OF_SCOPE;
    case "owner_only":
      return OWNER_ONLY_ALL_BRANCHES;
    case "archived_branch":
      return { code: "validation", message: "Staff can't be added to an archived branch." };
    case "last_branch":
      return {
        code: "validation",
        message: "This person must work in at least one branch. Add another branch before removing this one.",
      };
    case "validation":
      return { code: "validation", message: "One or more branches were not found in this academy." };
  }
}

/**
 * The body of `assignStaffBranches`, run inside the caller's transaction so
 * `setStaffWorkplace` can combine it with an all-branch grant or revoke
 * atomically. Replaces the staff member's whole branch set with
 * `desiredBranchIds` (already de-duplicated) after these checks:
 *
 * - the staff member and every branch belong to the actor's academy
 *   (`not_found` / `validation`, IDOR-safe);
 * - a branch being added is active;
 * - without all-branch access, the actor may only touch staff who share one
 *   of their branches, and only add or remove their own branches;
 * - taking someone with all-branch access off the Main Branch ends that
 *   grant, so only the owner may do it;
 * - a member limited to their branches (active, non-owner, no all-branch
 *   access afterwards) can't be left with no branch at all.
 */
async function replaceStaffBranchesInTx(
  tx: DbClient,
  actor: Actor,
  staffProfileId: string,
  desiredBranchIds: string[],
): Promise<ReplaceOutcome> {
  const academyId = actor.academyId;
  const [staff] = await tx
    .select({
      id: staffProfiles.id,
      userId: staffProfiles.userId,
      role: academyMemberships.role,
      academyWide: academyMemberships.academyWide,
    })
    .from(staffProfiles)
    .leftJoin(
      academyMemberships,
      and(
        eq(academyMemberships.userId, staffProfiles.userId),
        eq(academyMemberships.academyId, staffProfiles.academyId),
        eq(academyMemberships.status, "active"),
      ),
    )
    .where(and(eq(staffProfiles.id, staffProfileId), eq(staffProfiles.academyId, academyId)))
    .limit(1);
  if (!staff) {
    return { kind: "not_found" };
  }

  const existingBranchIds = await getBranchIdsForStaffProfile(tx, staffProfileId);
  const toAdd = desiredBranchIds.filter((id) => !existingBranchIds.includes(id));
  const toRemove = existingBranchIds.filter((id) => !desiredBranchIds.includes(id));

  if (desiredBranchIds.length > 0) {
    const owned = await tx
      .select({ id: branches.id, status: branches.status })
      .from(branches)
      .where(and(inArray(branches.id, desiredBranchIds), eq(branches.academyId, academyId)));
    if (owned.length !== desiredBranchIds.length) {
      return { kind: "validation" };
    }
    if (owned.some((row) => row.status !== "active" && toAdd.includes(row.id))) {
      return { kind: "archived_branch" };
    }
  }

  if (!actor.academyWide) {
    const actorBranchIds = await getAssignedBranchIds(tx, academyId, actor.userId);
    // The person must already work in one of the caller's branches (the
    // same staff the caller can see and manage), and every branch added or
    // removed must be one of the caller's own.
    const sharesABranch = existingBranchIds.some((id) => actorBranchIds.includes(id));
    if (!sharesABranch || [...toAdd, ...toRemove].some((id) => !actorBranchIds.includes(id))) {
      return { kind: "out_of_scope" };
    }
  }

  // All-branch access is only ever held by Main Branch staff: taking
  // someone off the Main Branch also ends a grant they hold (never the
  // owner's, which comes from the role itself) — an owner-only change.
  const [mainBranch] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.academyId, academyId), eq(branches.isMain, true)))
    .limit(1);
  const holdsGrant = staff.academyWide === true && staff.role !== "academy_owner";
  const endsGrant = holdsGrant && Boolean(mainBranch && toRemove.includes(mainBranch.id));
  if (endsGrant && actor.membershipRole !== "academy_owner") {
    return { kind: "owner_only" };
  }
  const limitedAfter = staff.role !== null && staff.role !== "academy_owner" && (!holdsGrant || endsGrant);
  if (limitedAfter && desiredBranchIds.length === 0 && existingBranchIds.length > 0) {
    return { kind: "last_branch" };
  }

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

  if (endsGrant) {
    const [revoked] = await tx
      .update(academyMemberships)
      .set({ academyWide: false })
      .where(
        and(
          eq(academyMemberships.academyId, academyId),
          eq(academyMemberships.userId, staff.userId),
          eq(academyMemberships.academyWide, true),
          ne(academyMemberships.role, "academy_owner"),
        ),
      )
      .returning({ id: academyMemberships.id });
    if (revoked) {
      await recordAudit(
        {
          actorUserId: actor.userId,
          actorRole: actor.membershipRole,
          academyId,
          action: "revokeAllBranchAccess",
          entityType: "staff_profile",
          entityId: staffProfileId,
          before: { allBranchAccess: true },
          after: { allBranchAccess: false },
          context: { reason: "Removed from the Main Branch" },
        },
        tx,
      );
    }
  }

  await recordAudit(
    {
      actorUserId: actor.userId,
      actorRole: actor.membershipRole,
      academyId,
      action: "assignStaffBranches",
      entityType: "staff_profile",
      entityId: staffProfileId,
      before: { branchIds: existingBranchIds },
      after: { branchIds: desiredBranchIds },
      context: { added: toAdd, removed: toRemove },
    },
    tx,
  );

  return { kind: "ok", branchIds: desiredBranchIds };
}

/**
 * PLAN.md §4: `assignStaffBranches` — replaces a staff member's *entire*
 * set of branch assignments in one call (diff against the existing
 * `staff_branch_assignments` rows, then insert what's new and delete what's
 * gone), the same "resubmit the whole set" convention `updateStaff` already
 * uses for the employment-record fields rather than a per-branch add/remove
 * pair of actions. Duplicate ids in the input are de-duplicated before
 * diffing, since the unique `(staff_profile_id, branch_id)` index would
 * otherwise reject a caller-supplied duplicate on insert.
 *
 * Every rule lives in `replaceStaffBranchesInTx`; the lookup, diff,
 * insert/delete, and audit write all happen inside one transaction — same
 * "a sensitive mutation cannot succeed if its audit write fails" posture as
 * every other mutation in this codebase.
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
  const actor = toActor(actorContext, access);

  const result = await db.transaction((tx) => replaceStaffBranchesInTx(tx, actor, staffProfileId, desiredBranchIds));
  if (result.kind !== "ok") {
    return { ok: false, error: replaceOutcomeError(result.kind) };
  }
  return { ok: true, branchIds: result.branchIds };
}

function toActor(
  actorContext: AuthContext,
  access: { academyId: string; membershipRole: AcademyRole; academyWide: boolean },
): Actor {
  return {
    userId: actorContext.userId,
    academyId: access.academyId,
    membershipRole: access.membershipRole,
    academyWide: access.academyWide,
  };
}

export type SetAllBranchAccessResult =
  | { ok: true; allBranchAccess: boolean; changed: boolean }
  | { ok: false; error: StaffBranchActionError };

type AllBranchOutcome =
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "owner" }
  | { kind: "not_on_main" }
  | { kind: "ok"; changed: boolean };

function allBranchOutcomeError(kind: Exclude<AllBranchOutcome["kind"], "ok">): StaffBranchActionError {
  switch (kind) {
    case "forbidden":
      return OWNER_ONLY_ALL_BRANCHES;
    case "not_found":
      return NOT_FOUND;
    case "owner":
      return { code: "validation", message: "The academy owner always has access to all branches." };
    case "not_on_main":
      return {
        code: "validation",
        message: "Assign this person to the Main Branch first. Only Main Branch staff can have access to all branches.",
      };
  }
}

/** The body of `setAllBranchAccess`, run inside the caller's transaction
 * (see that function for the rules). */
async function setAllBranchAccessInTx(
  tx: DbClient,
  actor: Actor,
  staffProfileId: string,
  enabled: boolean,
): Promise<AllBranchOutcome> {
  if (actor.membershipRole !== "academy_owner") return { kind: "forbidden" };
  const academyId = actor.academyId;
  const [target] = await tx
    .select({ userId: staffProfiles.userId, membershipId: academyMemberships.id, role: academyMemberships.role, academyWide: academyMemberships.academyWide })
    .from(staffProfiles)
    .innerJoin(
      academyMemberships,
      and(
        eq(academyMemberships.userId, staffProfiles.userId),
        eq(academyMemberships.academyId, staffProfiles.academyId),
        eq(academyMemberships.status, "active"),
      ),
    )
    .where(and(eq(staffProfiles.id, staffProfileId), eq(staffProfiles.academyId, academyId)))
    .for("update", { of: academyMemberships })
    .limit(1);
  if (!target) return { kind: "not_found" };
  if (target.role === "academy_owner") return { kind: "owner" };
  if (target.academyWide === enabled) return { kind: "ok", changed: false };

  if (enabled) {
    const [onMain] = await tx
      .select({ id: staffBranchAssignments.id })
      .from(staffBranchAssignments)
      .innerJoin(branches, eq(branches.id, staffBranchAssignments.branchId))
      .where(
        and(
          eq(staffBranchAssignments.staffProfileId, staffProfileId),
          eq(branches.academyId, academyId),
          eq(branches.isMain, true),
        ),
      )
      .limit(1);
    if (!onMain) return { kind: "not_on_main" };
  }

  await tx.update(academyMemberships).set({ academyWide: enabled }).where(eq(academyMemberships.id, target.membershipId));
  await recordAudit(
    {
      actorUserId: actor.userId,
      actorRole: actor.membershipRole,
      academyId,
      action: enabled ? "grantAllBranchAccess" : "revokeAllBranchAccess",
      entityType: "staff_profile",
      entityId: staffProfileId,
      before: { allBranchAccess: !enabled },
      after: { allBranchAccess: enabled },
    },
    tx,
  );
  return { kind: "ok", changed: true };
}

/**
 * Multi-branch: grants or revokes all-branch ("academy-wide") access for one
 * staff member — `academy_memberships.academy_wide`. Rules:
 *
 * - Only the academy owner may grant or revoke it.
 * - It can only be granted to someone assigned to the Main Branch (the Head
 *   Office holds the consolidated view). Revoking never needs that.
 * - The owner's own all-branch access comes from the role and can't be
 *   changed here.
 * - The staff member must hold an active membership in this academy.
 *
 * Every change is audited with before/after. Setting the value it already
 * has changes nothing and writes no audit row.
 */
export async function setAllBranchAccess(
  actorContext: AuthContext,
  staffProfileId: string,
  enabled: boolean,
): Promise<SetAllBranchAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  if (access.membershipRole !== "academy_owner") {
    return { ok: false, error: OWNER_ONLY_ALL_BRANCHES };
  }
  if (!z.string().uuid().safeParse(staffProfileId).success || typeof enabled !== "boolean") {
    return { ok: false, error: NOT_FOUND };
  }
  const actor = toActor(actorContext, access);

  const outcome = await db.transaction((tx) => setAllBranchAccessInTx(tx, actor, staffProfileId, enabled));
  if (outcome.kind !== "ok") return { ok: false, error: allBranchOutcomeError(outcome.kind) };
  return { ok: true, allBranchAccess: enabled, changed: outcome.changed };
}

export const staffWorkplaceSchema = z.object({
  workplace: z.enum(["all", "specific"]),
  branchIds: branchIdsSchema.optional(),
});

export type StaffWorkplaceInput = z.input<typeof staffWorkplaceSchema>;

export type SetStaffWorkplaceResult =
  | { ok: true; branchIds: string[]; allBranchAccess: boolean }
  | { ok: false; error: StaffBranchActionError };

/** Thrown inside the transaction to roll back a partly applied change. */
class WorkplaceRejected extends Error {
  constructor(public readonly error: StaffBranchActionError) {
    super(error.message);
  }
}

/**
 * Multi-branch: "Where they work" for an existing staff member (the staff
 * list's Edit branches dialog) — the same choice `createStaff` offers. One
 * transaction built from the two helpers above, so every rule is the one
 * `assignStaffBranches` and `setAllBranchAccess` already enforce:
 *
 * - "all": owner only. The person keeps their branches, is added to the
 *   Main Branch, and is granted all-branch access.
 * - "specific": the chosen branches (at least one). Someone who had
 *   all-branch access loses it first (owner only). An actor without
 *   all-branch access only sees and chooses among their own branches, so
 *   the person's other branches are kept as they are.
 *
 * Role, employment record and account are never touched. Any refusal rolls
 * the whole change back.
 */
export async function setStaffWorkplace(
  actorContext: AuthContext,
  staffProfileId: string,
  input: StaffWorkplaceInput,
): Promise<SetStaffWorkplaceResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  if (!canManageStaff(getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION))) {
    return { ok: false, error: FORBIDDEN };
  }
  if (!z.string().uuid().safeParse(staffProfileId).success) {
    return { ok: false, error: NOT_FOUND };
  }
  const parsed = staffWorkplaceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: "Invalid branch choice." } };
  }
  const { workplace } = parsed.data;
  const chosen = Array.from(new Set(parsed.data.branchIds ?? []));
  if (workplace === "all" && access.membershipRole !== "academy_owner") {
    return { ok: false, error: OWNER_ONLY_ALL_BRANCHES };
  }
  if (workplace === "specific" && chosen.length === 0) {
    return { ok: false, error: { code: "validation", message: "Choose at least one branch where this person works." } };
  }
  const actor = toActor(actorContext, access);
  const academyId = access.academyId;

  try {
    const result = await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ role: academyMemberships.role, academyWide: academyMemberships.academyWide })
        .from(staffProfiles)
        .leftJoin(
          academyMemberships,
          and(
            eq(academyMemberships.userId, staffProfiles.userId),
            eq(academyMemberships.academyId, staffProfiles.academyId),
            eq(academyMemberships.status, "active"),
          ),
        )
        .where(and(eq(staffProfiles.id, staffProfileId), eq(staffProfiles.academyId, academyId)))
        .limit(1);
      if (!target) throw new WorkplaceRejected(NOT_FOUND);
      if (target.role === "academy_owner") {
        throw new WorkplaceRejected({ code: "validation", message: "The academy owner always works across all branches." });
      }
      const existing = await getBranchIdsForStaffProfile(tx, staffProfileId);

      const replace = async (desired: string[]) => {
        const outcome = await replaceStaffBranchesInTx(tx, actor, staffProfileId, desired);
        if (outcome.kind !== "ok") throw new WorkplaceRejected(replaceOutcomeError(outcome.kind));
        return outcome.branchIds;
      };
      const setAll = async (enabled: boolean) => {
        const outcome = await setAllBranchAccessInTx(tx, actor, staffProfileId, enabled);
        if (outcome.kind !== "ok") throw new WorkplaceRejected(allBranchOutcomeError(outcome.kind));
      };

      if (workplace === "all") {
        const [mainBranch] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.academyId, academyId), eq(branches.isMain, true)))
          .limit(1);
        if (!mainBranch) {
          throw new WorkplaceRejected({ code: "validation", message: "This academy has no Main Branch yet." });
        }
        const branchIds = existing.includes(mainBranch.id) ? existing : await replace([...existing, mainBranch.id]);
        await setAll(true);
        return { branchIds, allBranchAccess: true };
      }

      if (target.academyWide) {
        // setAllBranchAccessInTx refuses anyone but the owner.
        await setAll(false);
      }
      let desired = chosen;
      if (!access.academyWide) {
        const own = await getAssignedBranchIds(tx, academyId, actor.userId);
        desired = Array.from(new Set([...chosen, ...existing.filter((id) => !own.includes(id))]));
      }
      return { branchIds: await replace(desired), allBranchAccess: false };
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof WorkplaceRejected) return { ok: false, error: err.error };
    throw err;
  }
}
