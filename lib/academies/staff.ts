import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getAssignedBranchIds } from "@/lib/academies/branch-access";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  academyMemberships,
  batchTrainerAssignments,
  branches,
  courses,
  staffBranchAssignments,
  staffDocuments,
  staffProfiles,
  timetables,
  users,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_STAFF_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { checkAllowance } from "@/lib/subscriptions/usage";
import { recordAudit } from "@/lib/audit";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import type { AuthContext } from "@/lib/auth/auth-context";
import { ACADEMY_ROLES, type AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 2, Item 35 — "Staff create/update + role assignment +
 * checkAllowance('staff')".
 *
 * Every action here resolves "which academy, with what role" via
 * checkAcademyAccessForContext (lib/academies/access-gate.ts, Item 27),
 * exactly like lib/academies/settings.ts (Item 41) — never a
 * client-supplied academyId.
 *
 * `staff_profiles` (Item 33) deliberately has no `role` column — see that
 * table's own doc comment in lib/db/schema.ts. A staff member's system
 * role/access lives entirely on their `academy_memberships` row. So
 * "create a staff member" here is really three things in one transaction:
 * (1) a `users` row for the person (create-or-reuse — see createStaff's own
 * comment), (2) a `staff_profiles` row (the employment record), and (3) an
 * `academy_memberships` row carrying the role (`assignStaffRole`'s own
 * concern, reused inline here for the create path so a brand-new staff
 * member is never left without a role).
 */

const MANAGE_LEVELS: ReadonlySet<AcademyPermissionLevel> = new Set(["full", "manage"]);

function canManageStaff(level: AcademyPermissionLevel): boolean {
  return MANAGE_LEVELS.has(level);
}

function canViewStaff(level: AcademyPermissionLevel): boolean {
  return level !== "none";
}

export interface StaffActionError {
  code:
    | "forbidden"
    | "validation"
    | "blocked"
    | "not_found"
    | "allowance_exceeded"
    | "already_staff"
    | "conflict"
    | "ineligible";
  message: string;
}

const FORBIDDEN: StaffActionError = {
  code: "forbidden",
  message: "You don't have permission to manage this academy's staff.",
};

// Same "blank string -> undefined" convention as lib/academies/settings.ts's
// optionalText — duplicated rather than imported, matching that file's own
// documented reasoning (a different item's file, out of scope to modify).
function optionalText(maxLength = 500) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

function optionalEmail(maxLength = 200) {
  return z
    .string()
    .trim()
    .toLowerCase()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined))
    .refine((value) => value === undefined || z.string().email().safeParse(value).success, {
      message: "Enter a valid email address",
    });
}

export const createStaffSchema = z.object({
  // Login email for the person's `users` account — also stored as
  // staff_profiles.email (that column is nullable/independent in the
  // schema, but PLAN.md never describes a staff member having a separate
  // "contact email" from their login email, so this reuses the one value
  // for both, documented here as the judgment call it is).
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  // Only required when no `users` row exists yet for this email — see
  // createStaff's "create-or-reuse" comment. Left optional at the schema
  // level; enforced inside createStaff once it knows which branch applies.
  password: z.string().optional(),
  fullName: z.string().trim().min(1, "Full name is required").max(200),
  phone: z.string().trim().min(1, "Phone is required").max(50),
  employeeNumber: optionalText(100),
  // PLAN.md's literal column is `hire_date date nullable` — accepted as a
  // plain "YYYY-MM-DD" string and passed straight through to Drizzle's
  // `date()` column type, same convention this codebase uses for every
  // other date column (no separate Date-object parsing layer exists
  // anywhere in this repo for a `date` — as opposed to `timestamp` —
  // column).
  hireDate: optionalText(20),
  role: z.enum(ACADEMY_ROLES),
  // Multi-branch: where the person works. "all" = all-branch access (owner
  // only; the person is placed on the Main Branch, which that grant
  // requires). "specific" = only `branchIds`, each of which the creator
  // must be able to work in. Omitted keeps the earlier default: no branch
  // for an all-branch creator, the creator's own branches otherwise.
  workplace: z.enum(["all", "specific"]).optional(),
  branchIds: z.array(z.string().uuid("Choose a valid branch")).max(200).optional(),
});

export type CreateStaffInput = z.input<typeof createStaffSchema>;

export interface StaffWorkplaceOptions {
  /** Only the owner can give a new staff member all-branch access. */
  canGrantAllBranches: boolean;
  /** Active branches the creator can place staff in (their own branches unless all-branch). */
  branches: { id: string; name: string; isMain: boolean }[];
}

/** The branches offered by the "Where they work" field when registering staff. */
export async function getStaffWorkplaceOptions(
  actorContext: AuthContext,
): Promise<{ ok: true; options: StaffWorkplaceOptions } | { ok: false; error: StaffActionError }> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  if (!canManageStaff(getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION))) {
    return { ok: false, error: FORBIDDEN };
  }
  const conditions = [eq(branches.academyId, access.academyId), eq(branches.status, "active")];
  if (!access.academyWide) {
    const own = await getAssignedBranchIds(db, access.academyId, actorContext.userId);
    if (own.length === 0) {
      return { ok: true, options: { canGrantAllBranches: false, branches: [] } };
    }
    conditions.push(inArray(branches.id, own));
  }
  const rows = await db
    .select({ id: branches.id, name: branches.name, isMain: branches.isMain })
    .from(branches)
    .where(and(...conditions))
    .orderBy(desc(branches.isMain), asc(branches.name));
  return {
    ok: true,
    options: { canGrantAllBranches: access.membershipRole === "academy_owner", branches: rows },
  };
}

export interface StaffRecord {
  id: string;
  userId: string;
  employeeNumber: string | null;
  fullName: string;
  phone: string;
  email: string | null;
  hireDate: string | null;
  status: "active" | "archived";
}

function toRecord(row: typeof staffProfiles.$inferSelect): StaffRecord {
  return {
    id: row.id,
    userId: row.userId,
    employeeNumber: row.employeeNumber,
    fullName: row.fullName,
    phone: row.phone,
    email: row.email,
    hireDate: row.hireDate,
    status: row.status,
  };
}

export type CreateStaffResult =
  | { ok: true; staffProfileId: string; userId: string; role: AcademyRole }
  | { ok: false; error: StaffActionError };

class AllowanceExceeded extends Error {
  constructor(public readonly current: number, public readonly limit: number) {
    super(`Staff allowance limit reached (${current}/${limit}).`);
  }
}

class AlreadyStaff extends Error {}

class OutsideOwnBranches extends Error {}

/**
 * PLAN.md §4: `createStaff` (`checkAllowance('staff')`). Gated by the new
 * `academy.staff` row (lib/auth/academy-permissions.ts): only Full/Manage
 * (Owner, Admin, Manager) may create staff — Trainer's "View" and
 * Admissions/Finance's "none" both refuse.
 *
 * "Create-or-reuse a users row" (task brief): if a `users` row with this
 * email already exists, it is reused (no second account, no duplicate
 * `users.email` unique-index violation) as long as that person isn't
 * already staff at *this* academy (checked against both `staff_profiles`
 * and `academy_memberships` — either one existing for this
 * (academyId, userId) pair means "already staff here", surfaced as
 * `already_staff` rather than silently doubling their record). A brand
 * new email requires a password (validated with the shared
 * `passwordSchema`) to create the account; reusing an existing user never
 * touches their existing password.
 *
 * `checkAllowance('staff')` runs first, inside the same transaction as
 * every insert below (via the transaction's own client), so the check and
 * the write that would consume the slot can never race against a
 * concurrent createStaff call the way two independent reads could.
 */
export async function createStaff(
  actorContext: AuthContext,
  input: CreateStaffInput,
): Promise<CreateStaffResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (!canManageStaff(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createStaffSchema.safeParse(input);
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
  const academyId = access.academyId;

  // Owner-safety guard (delete/deletion-audit pass): creating a brand-new
  // staff member with role "academy_owner" is the same ownership-grant this
  // file's assignStaffRole gates on already-being-an-owner — without this,
  // a Manager (who already passes canManageStaff above) could mint an
  // entirely new owner account from scratch, bypassing that same guard.
  if (data.role === "academy_owner" && access.membershipRole !== "academy_owner") {
    return { ok: false, error: { code: "forbidden", message: "Only an academy owner can grant ownership." } };
  }

  // Where the person works. An owner already has every branch through the
  // role itself, so the choice only matters for the other roles.
  const workplace = data.role === "academy_owner" ? undefined : data.workplace;
  const grantAllBranches = workplace === "all";
  if (grantAllBranches && access.membershipRole !== "academy_owner") {
    return {
      ok: false,
      error: { code: "forbidden", message: "Only the academy owner can give someone access to all branches." },
    };
  }
  const chosenBranchIds = workplace === "specific" ? [...new Set(data.branchIds ?? [])] : [];
  if (workplace === "specific" && chosenBranchIds.length === 0) {
    return { ok: false, error: { code: "validation", message: "Choose at least one branch where this person works." } };
  }

  try {
    const result = await db.transaction(async (tx) => {
      const allowance = await checkAllowance(academyId, "staff", tx);
      if (!allowance.ok) {
        // A no_plan/validation failure here would mean
        // checkAcademyAccessForContext's own subscription requirement was
        // somehow bypassed — defensive, treated as a hard block same as an
        // exceeded allowance so createStaff never silently succeeds past a
        // broken allowance read.
        throw new AllowanceExceeded(0, 0);
      }
      if (!allowance.result.allowed) {
        throw new AllowanceExceeded(allowance.result.current, allowance.result.limit);
      }

      const [existingUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, data.email))
        .limit(1);

      let userId: string;
      // Only set when re-using an existing user who has a "removed"
      // membership row for this academy (see below) — reactivated in
      // place rather than left to collide with the (user_id, academy_id)
      // unique constraint on a fresh insert.
      let removedMembershipId: string | null = null;
      if (existingUser) {
        userId = existingUser.id;

        const [existingProfile] = await tx
          .select({ id: staffProfiles.id })
          .from(staffProfiles)
          .where(
            and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, userId)),
          )
          .limit(1);
        if (existingProfile) {
          throw new AlreadyStaff();
        }

        // A "removed" row here (deleteStaff's own precondition — see that
        // function's module comment: it never proceeds while an active
        // membership exists, so the only way a membership can outlive a
        // deleted staff_profiles row is already "removed") is this same
        // person's prior employment record, not a live conflict. Only an
        // *active* membership means "already staff" — a removed one just
        // means "was staff here before," which createStaff must be able to
        // re-hire, not permanently lock the email out of this academy.
        const [existingMembership] = await tx
          .select({ id: academyMemberships.id, status: academyMemberships.status })
          .from(academyMemberships)
          .where(
            and(
              eq(academyMemberships.academyId, academyId),
              eq(academyMemberships.userId, userId),
            ),
          )
          .limit(1);
        if (existingMembership) {
          if (existingMembership.status === "active") {
            throw new AlreadyStaff();
          }
          removedMembershipId = existingMembership.id;
        }
      } else {
        const passwordCheck = passwordSchema.safeParse(data.password);
        if (!passwordCheck.success) {
          throw new Error(
            "validation:" +
              (passwordCheck.error.issues[0]?.message ??
                "A password is required to create a new staff account."),
          );
        }
        const passwordHash = await hashPassword(passwordCheck.data);
        const [newUser] = await tx
          .insert(users)
          .values({ email: data.email, passwordHash })
          .returning({ id: users.id });
        userId = newUser.id;
      }

      // Resolve the branches before any membership write. A re-hired
      // person's earlier all-branch access is never carried over: it is set
      // from this request's choice alone.
      let assignedBranchIds: string[] = [];
      if (grantAllBranches) {
        // All-branch access is only for Main Branch staff.
        const [main] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.academyId, academyId), eq(branches.isMain, true)))
          .limit(1);
        if (!main) {
          throw new Error("validation:This academy has no Main Branch yet. Add a branch first.");
        }
        assignedBranchIds = [main.id];
      } else if (workplace === "specific") {
        const found = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(
            and(
              eq(branches.academyId, academyId),
              eq(branches.status, "active"),
              inArray(branches.id, chosenBranchIds),
            ),
          );
        if (found.length !== chosenBranchIds.length) {
          throw new Error("validation:One of the chosen branches is not available. Refresh and try again.");
        }
        if (!access.academyWide) {
          const own = new Set(await getAssignedBranchIds(tx, academyId, actorContext.userId));
          if (!chosenBranchIds.every((id) => own.has(id))) {
            throw new OutsideOwnBranches();
          }
        }
        assignedBranchIds = chosenBranchIds;
      } else if (!access.academyWide) {
        // Earlier default: staff added by someone without all-branch access
        // start in that person's own branches (otherwise they could never
        // see or manage the person they just added).
        assignedBranchIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
      }

      if (removedMembershipId) {
        await tx
          .update(academyMemberships)
          .set({ role: data.role, status: "active", academyWide: grantAllBranches })
          .where(eq(academyMemberships.id, removedMembershipId));
      } else {
        await tx.insert(academyMemberships).values({
          userId,
          academyId,
          role: data.role,
          status: "active",
          academyWide: grantAllBranches,
        });
      }

      const [profile] = await tx
        .insert(staffProfiles)
        .values({
          academyId,
          userId,
          employeeNumber: data.employeeNumber,
          fullName: data.fullName,
          phone: data.phone,
          email: data.email,
          hireDate: data.hireDate,
        })
        .returning();

      // Multi-branch: the branches resolved above, recorded in the audit row below.
      if (assignedBranchIds.length > 0) {
        await tx
          .insert(staffBranchAssignments)
          .values(assignedBranchIds.map((branchId) => ({ academyId, staffProfileId: profile.id, branchId })));
      }

      // Same-transaction audit write (Cross-Cutting Architecture Decisions:
      // "a sensitive mutation cannot succeed if its audit write fails").
      // Never includes the password/hash.
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: access.membershipRole,
          academyId,
          action: "createStaff",
          entityType: "staff_profile",
          entityId: profile.id,
          after: {
            ...toRecord(profile),
            role: data.role,
            email: data.email,
            branchIds: assignedBranchIds,
            allBranchAccess: grantAllBranches,
          },
        },
        tx,
      );

      return { staffProfileId: profile.id, userId, role: data.role };
    });

    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof AllowanceExceeded) {
      return {
        ok: false,
        error: {
          code: "allowance_exceeded",
          message:
            err.limit > 0
              ? `Staff allowance limit reached (${err.current}/${err.limit}). Archive an existing staff member or upgrade your plan.`
              : "Staff allowance could not be verified for this academy.",
        },
      };
    }
    if (err instanceof OutsideOwnBranches) {
      return {
        ok: false,
        error: { code: "forbidden", message: "You can only add staff to the branches you work in." },
      };
    }
    if (err instanceof AlreadyStaff) {
      return {
        ok: false,
        error: {
          code: "already_staff",
          message: "This person is already a staff member of this academy.",
        },
      };
    }
    if (err instanceof Error && err.message.startsWith("validation:")) {
      return {
        ok: false,
        error: { code: "validation", message: err.message.slice("validation:".length) },
      };
    }
    if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "This staff member could not be created due to a conflicting record.",
        },
      };
    }
    throw err;
  }
}

export const updateStaffSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required").max(200),
  phone: z.string().trim().min(1, "Phone is required").max(50),
  email: optionalEmail(),
  employeeNumber: optionalText(100),
  hireDate: optionalText(20),
  status: z.enum(["active", "archived"]).optional(),
});

export type UpdateStaffInput = z.input<typeof updateStaffSchema>;

export type UpdateStaffResult =
  | { ok: true; staff: StaffRecord }
  | { ok: false; error: StaffActionError };

/**
 * PLAN.md §4: `updateStaff` (`checkAllowance` only gates *creation*, per
 * the brief's own parenthetical — this action never re-checks allowance).
 * Full-object update of the employment record fields, same "resubmit the
 * whole form" convention as lib/academies/settings.ts's
 * updateAcademySettings. `status` is included here (rather than a separate
 * archiveStaff action, which PLAN.md's Item 35 doesn't name) since
 * Archive & Deactivation Rules makes "status = archived" staff_profiles'
 * only removal path, and archiving is what frees the plan's staff
 * allowance slot (countActiveStaff, lib/subscriptions/usage.ts, only
 * counts `status = 'active'`).
 */
export async function updateStaff(
  actorContext: AuthContext,
  staffProfileId: string,
  input: UpdateStaffInput,
): Promise<UpdateStaffResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (!canManageStaff(level)) {
    return { ok: false, error: FORBIDDEN };
  }
  // Multi-branch: only staff the caller can see (same rule as listStaff).
  if (!(await isStaffProfileInScope(access, actorContext.userId, staffProfileId))) {
    return { ok: false, error: { code: "not_found", message: "Staff member not found." } };
  }

  const parsed = updateStaffSchema.safeParse(input);
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
    // Tenant-scoped lookup (IDOR-safe): a staffProfileId from another
    // academy simply doesn't match this WHERE clause, same posture as
    // every other tenant-scoped mutation in this codebase.
    const [existing] = await tx
      .select()
      .from(staffProfiles)
      .where(
        and(eq(staffProfiles.id, staffProfileId), eq(staffProfiles.academyId, access.academyId)),
      )
      .limit(1);
    if (!existing) return null;

    const [updated] = await tx
      .update(staffProfiles)
      .set({
        fullName: data.fullName,
        phone: data.phone,
        email: data.email,
        employeeNumber: data.employeeNumber,
        hireDate: data.hireDate,
        status: data.status ?? existing.status,
        updatedAt: new Date(),
      })
      .where(eq(staffProfiles.id, staffProfileId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: access.membershipRole,
        academyId: access.academyId,
        action: "updateStaff",
        entityType: "staff_profile",
        entityId: staffProfileId,
        before: toRecord(existing),
        after: toRecord(updated),
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return { ok: false, error: { code: "not_found", message: "Staff member not found." } };
  }
  return { ok: true, staff: toRecord(result) };
}

export type AssignStaffRoleResult =
  | { ok: true; userId: string; role: AcademyRole }
  | { ok: false; error: StaffActionError };

/**
 * PLAN.md §4: `assignStaffRole`. Operates on the target's existing
 * `academy_memberships` row for this academy (see lib/db/schema.ts's
 * staff_profiles comment: role/system-access lives there, not on
 * staff_profiles) — the target must already be a member of this academy
 * (created either by createStaff above or by an earlier onboarding flow);
 * this action only ever changes the role column, never creates a
 * membership from scratch.
 *
 * ---------------------------------------------------------------------
 * Owner-safety guard (added in the delete/deletion-audit pass)
 * ---------------------------------------------------------------------
 * Before this guard, `canManageStaff(level)` alone gated this action —
 * Manager holds "manage" on `academy.staff`, the same level this function
 * already accepted, so a Manager (not just Owner/Admin) could grant
 * themselves or anyone else the `academy_owner` role, or strip the real
 * owner of it, with no special check at all. Two rules now apply
 * specifically to the `academy_owner` role (every other role transition is
 * unchanged — Owner/Admin/Manager all keep exactly the authority they had):
 *   1. Only an existing `academy_owner` may grant OR remove the
 *      `academy_owner` role — this is the "ownership transfer" mechanism
 *      this codebase has (there is no separate dedicated transfer action),
 *      so it must not be reachable by anyone below owner.
 *   2. An academy may never be left with zero active owners — demoting the
 *      last remaining `academy_owner` membership is refused outright; a
 *      successor must be promoted first.
 */
export async function assignStaffRole(
  actorContext: AuthContext,
  targetUserId: string,
  role: AcademyRole,
): Promise<AssignStaffRoleResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (!canManageStaff(level)) {
    return { ok: false, error: FORBIDDEN };
  }
  if (!(await isStaffUserInScope(access, actorContext.userId, targetUserId))) {
    return { ok: false, error: { code: "not_found", message: "Staff member not found." } };
  }

  const parsedRole = z.enum(ACADEMY_ROLES).safeParse(role);
  if (!parsedRole.success) {
    return { ok: false, error: { code: "validation", message: "Invalid role." } };
  }

  // Rule 1a: granting ownership itself requires already being an owner.
  if (parsedRole.data === "academy_owner" && access.membershipRole !== "academy_owner") {
    return { ok: false, error: { code: "forbidden", message: "Only an academy owner can grant ownership." } };
  }

  type Outcome =
    | { kind: "not_found" }
    | { kind: "owner_only" }
    | { kind: "last_owner" }
    | { kind: "ok"; userId: string; role: AcademyRole };

  const result: Outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(academyMemberships)
      .where(
        and(
          eq(academyMemberships.userId, targetUserId),
          eq(academyMemberships.academyId, access.academyId),
        ),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" };

    // Rule 1b: demoting an existing owner away from "academy_owner" also
    // requires the actor to already be an owner themselves.
    if (existing.role === "academy_owner" && parsedRole.data !== "academy_owner") {
      if (access.membershipRole !== "academy_owner") {
        return { kind: "owner_only" };
      }

      // Rule 2: never demote the last remaining owner.
      const owners = await tx
        .select({ id: academyMemberships.id })
        .from(academyMemberships)
        .where(
          and(
            eq(academyMemberships.academyId, access.academyId),
            eq(academyMemberships.role, "academy_owner"),
            eq(academyMemberships.status, "active"),
          ),
        );
      if (owners.length <= 1) {
        return { kind: "last_owner" };
      }
    }

    const [updated] = await tx
      .update(academyMemberships)
      .set({ role: parsedRole.data })
      .where(eq(academyMemberships.id, existing.id))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: access.membershipRole,
        academyId: access.academyId,
        action: "assignStaffRole",
        entityType: "academy_membership",
        entityId: existing.id,
        before: { role: existing.role },
        after: { role: updated.role },
      },
      tx,
    );

    return { kind: "ok", userId: updated.userId, role: updated.role };
  });

  switch (result.kind) {
    case "not_found":
      return {
        ok: false,
        error: { code: "not_found", message: "This user is not a staff member of this academy." },
      };
    case "owner_only":
      return {
        ok: false,
        error: { code: "forbidden", message: "Only an academy owner can change another owner's role." },
      };
    case "last_owner":
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "This is the only remaining owner. Promote another member to owner first.",
        },
      };
    case "ok":
      return { ok: true, userId: result.userId, role: result.role };
  }
}

export type RemoveStaffMembershipResult = { ok: true } | { ok: false; error: StaffActionError };

/**
 * New in the delete/deletion-audit pass: this is the actual "remove access"
 * lib/db/schema.ts's own `membershipStatusEnum` comment has always described
 * ("Removing an academy membership revokes that user's active sessions for
 * that academy context") but that no code ever wrote until now —
 * `updateStaff`'s status toggle only ever flips `staff_profiles.status`, a
 * separate column recording employment record state, never
 * `academy_memberships.status`, so an "archived" staff member kept full
 * academy login access under the pre-existing code. This is the "delete"
 * for staff membership per this task's audit: never a hard row delete
 * (audit rows, exam results, payments, etc. recorded under this person's
 * `user_id` must stay resolvable) — a status flip to `"removed"`, the exact
 * same soft-removal shape every other entity in this codebase already uses
 * (branches/courses/batches/programs `status: archived`, certificates
 * `status: cancelled`, ...).
 *
 * Owner-safety: identical two rules as assignStaffRole's demotion path —
 * removing an `academy_owner` membership requires the actor to already be
 * an owner, and is refused if it would leave zero active owners. There is
 * no ownership-transfer action in this codebase to point someone at instead
 * — assignStaffRole already IS that transfer (promote a successor to
 * `academy_owner`, then remove the original).
 */
export async function removeStaffMembership(
  actorContext: AuthContext,
  targetUserId: string,
): Promise<RemoveStaffMembershipResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (!canManageStaff(level)) {
    return { ok: false, error: FORBIDDEN };
  }
  if (!(await isStaffUserInScope(access, actorContext.userId, targetUserId))) {
    return { ok: false, error: { code: "not_found", message: "Staff member not found." } };
  }

  const parsedTargetId = z.string().uuid().safeParse(targetUserId);
  if (!parsedTargetId.success) {
    return {
      ok: false,
      error: { code: "not_found", message: "This user is not an active staff member of this academy." },
    };
  }

  type Outcome = { kind: "not_found" } | { kind: "owner_only" } | { kind: "last_owner" } | { kind: "ok"; id: string };

  const result: Outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(academyMemberships)
      .where(
        and(
          eq(academyMemberships.userId, targetUserId),
          eq(academyMemberships.academyId, access.academyId),
          eq(academyMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" };

    if (existing.role === "academy_owner") {
      if (access.membershipRole !== "academy_owner") {
        return { kind: "owner_only" };
      }

      const owners = await tx
        .select({ id: academyMemberships.id })
        .from(academyMemberships)
        .where(
          and(
            eq(academyMemberships.academyId, access.academyId),
            eq(academyMemberships.role, "academy_owner"),
            eq(academyMemberships.status, "active"),
          ),
        );
      if (owners.length <= 1) {
        return { kind: "last_owner" };
      }
    }

    // Multi-branch: a removed membership never keeps all-branch access, so
    // nothing carries over if the person is ever re-hired.
    await tx
      .update(academyMemberships)
      .set({ status: "removed", academyWide: false })
      .where(eq(academyMemberships.id, existing.id));

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: access.membershipRole,
        academyId: access.academyId,
        action: "removeStaffMembership",
        entityType: "academy_membership",
        entityId: existing.id,
        before: { status: existing.status, role: existing.role, allBranchAccess: existing.academyWide },
        after: { status: "removed", allBranchAccess: false },
      },
      tx,
    );

    return { kind: "ok", id: existing.id };
  });

  switch (result.kind) {
    case "not_found":
      return {
        ok: false,
        error: { code: "not_found", message: "This user is not an active staff member of this academy." },
      };
    case "owner_only":
      return {
        ok: false,
        error: { code: "forbidden", message: "Only an academy owner can remove another owner's access." },
      };
    case "last_owner":
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "This is the only remaining owner. Promote another member to owner first.",
        },
      };
    case "ok":
      return { ok: true };
  }
}

export interface StaffListRow extends StaffRecord {
  role: AcademyRole | null;
  loginEmail: string;
  /** Multi-branch: the owner, or a member the owner granted all-branch access. */
  allBranchAccess: boolean;
  /** Branches they work in that the viewer can see (all of them for an
   * all-branch viewer, otherwise only the viewer's own), Main first. */
  branches: { id: string; name: string; isMain: boolean }[];
  /** Further branches outside the viewer's own, counted but not named. */
  otherBranchCount: number;
  /** Whether the viewer may change where this person works (see
   * `setStaffWorkplace`, which checks the same rules on the server). */
  canEditBranches: boolean;
}

export interface StaffDeletionEligibilitySummary {
  eligible: boolean;
  reasons: string[];
}

export type ListStaffResult =
  | {
      ok: true;
      staff: (StaffListRow & { deletionEligibility: StaffDeletionEligibilitySummary })[];
      permissionLevel: AcademyPermissionLevel;
      /** Owner/Admin/Manager only — see `canManageStaff`'s own callers.
       * The UI renders the Delete action only when this is true. */
      canDelete: boolean;
    }
  | { ok: false; error: StaffActionError };

/**
 * PLAN.md Phase 2, Item 36 — branch-scoped filter for `listStaff`. Resolves
 * which `staff_profiles` rows a branch-limited viewer (in practice: Trainer,
 * whose `academy.staff` permission level is "view" per the Master
 * Permission Matrix's "View self/assigned" cell — Admissions Officer and
 * Finance Officer are already refused entirely at "none" and never reach
 * this) may see: their own record, plus any staff member who shares at
 * least one assigned branch with them.
 *
 * Same join pattern lib/academies/branches.ts's own `getAssignedBranchIds`
 * uses as its template (staff_profiles -> staff_branch_assignments by
 * staff_profile_id) — duplicated rather than imported since that file is
 * this item's read-only reference, not something to couple to. A viewer
 * with no `staff_profiles` row at all (or one with zero assignments) sees
 * only themselves-if-they-have-a-profile — an empty/near-empty result, not
 * an error, mirroring that file's own "assigned to nothing" convention for
 * branch-limited roles.
 */
async function getViewableStaffProfileIds(
  academyId: string,
  actorUserId: string,
): Promise<string[]> {
  const [viewerProfile] = await db
    .select({ id: staffProfiles.id })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, actorUserId)))
    .limit(1);

  const visible = new Set<string>();
  if (viewerProfile) visible.add(viewerProfile.id);

  const viewerBranchIds = viewerProfile
    ? (
        await db
          .select({ branchId: staffBranchAssignments.branchId })
          .from(staffBranchAssignments)
          .where(eq(staffBranchAssignments.staffProfileId, viewerProfile.id))
      ).map((row) => row.branchId)
    : [];

  if (viewerBranchIds.length > 0) {
    const shared = await db
      .selectDistinct({ staffProfileId: staffBranchAssignments.staffProfileId })
      .from(staffBranchAssignments)
      .where(
        and(
          eq(staffBranchAssignments.academyId, academyId),
          inArray(staffBranchAssignments.branchId, viewerBranchIds),
        ),
      );
    for (const row of shared) visible.add(row.staffProfileId);
  }

  return Array.from(visible);
}

async function isStaffProfileInScope(
  access: { academyId: string; academyWide: boolean },
  actorUserId: string,
  staffProfileId: string,
): Promise<boolean> {
  if (access.academyWide) return true;
  return (await getViewableStaffProfileIds(access.academyId, actorUserId)).includes(staffProfileId);
}

async function isStaffUserInScope(
  access: { academyId: string; academyWide: boolean },
  actorUserId: string,
  targetUserId: string,
): Promise<boolean> {
  if (access.academyWide) return true;
  const [profile] = await db
    .select({ id: staffProfiles.id })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.academyId, access.academyId), eq(staffProfiles.userId, targetUserId)))
    .limit(1);
  return Boolean(profile) && (await getViewableStaffProfileIds(access.academyId, actorUserId)).includes(profile.id);
}

/**
 * PLAN.md §3's `/academy/staff` list. Gated by `canViewStaff` (any
 * non-"none" level: Full, Manage, or Trainer's "View") rather than
 * `canManageStaff`, since Trainer can see staff per the matrix even though
 * it can't create/update them.
 *
 * Branch-scoped per Item 36 (Phase 2 §6: "further by branch_id for
 * branch-limited roles ... academy-wide roles ... skip the branch filter by
 * design, not by accident"): "full"/"manage" (Owner/Admin/Manager) get
 * every staff_profiles row for the academy, unfiltered; "view" (Trainer)
 * gets only their own record plus staff who share at least one assigned
 * branch with them, via `getViewableStaffProfileIds` above. IDOR-safe by
 * construction — a staff member outside the viewer's visible set simply
 * never appears in the list, the same "doesn't exist vs. exists-but-hidden
 * must be indistinguishable" posture lib/academies/branches.ts uses for its
 * own branch-limited reads.
 */
type StaffListScope =
  | { ok: false; error: StaffActionError }
  | {
      ok: true;
      academyId: string;
      level: AcademyPermissionLevel;
      /** null = every staff profile in the academy; otherwise only these. */
      visibleStaffProfileIds: string[] | null;
      academyWide: boolean;
      membershipRole: AcademyRole;
    };

/** The gate and visibility rule `listStaff` and `listStaffSummaries` share,
 * so both always return the same set of staff for the same caller. */
async function resolveStaffListScope(actorContext: AuthContext): Promise<StaffListScope> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (!canViewStaff(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  let visibleStaffProfileIds: string[] | null = null;
  // Multi-branch: without all-branch access, staff management is limited to
  // the caller's own record plus staff sharing one of their branches.
  if (!canManageStaff(level) || !access.academyWide) {
    // "view" is the only remaining non-"none" level today (Trainer) — see
    // listStaff's own doc comment.
    visibleStaffProfileIds = await getViewableStaffProfileIds(
      access.academyId,
      actorContext.userId,
    );
  }
  return {
    ok: true,
    academyId: access.academyId,
    level,
    visibleStaffProfileIds,
    academyWide: access.academyWide,
    membershipRole: access.membershipRole,
  };
}

export type ListStaffSummariesResult =
  | { ok: true; staff: Pick<StaffRecord, "id" | "fullName" | "status">[] }
  | { ok: false; error: StaffActionError };

/**
 * Performance plan P4/P5: the same staff `listStaff` returns for this caller
 * (same gate, same visibility rule, same academy scope), but only id, name
 * and status — for pickers and counts that never show deletion eligibility,
 * so the three dependency-count queries `listStaff` runs are skipped.
 */
export async function listStaffSummaries(actorContext: AuthContext): Promise<ListStaffSummariesResult> {
  const scope = await resolveStaffListScope(actorContext);
  if (!scope.ok) return scope;
  const { academyId, visibleStaffProfileIds } = scope;
  if (visibleStaffProfileIds && visibleStaffProfileIds.length === 0) return { ok: true, staff: [] };

  const staff = await db
    .select({ id: staffProfiles.id, fullName: staffProfiles.fullName, status: staffProfiles.status })
    .from(staffProfiles)
    .innerJoin(users, eq(users.id, staffProfiles.userId))
    .where(
      visibleStaffProfileIds
        ? and(eq(staffProfiles.academyId, academyId), inArray(staffProfiles.id, visibleStaffProfileIds))
        : eq(staffProfiles.academyId, academyId),
    );
  return { ok: true, staff };
}

export async function listStaff(actorContext: AuthContext): Promise<ListStaffResult> {
  const scope = await resolveStaffListScope(actorContext);
  if (!scope.ok) return scope;
  const { level, visibleStaffProfileIds } = scope;
  const access = { academyId: scope.academyId };
  if (visibleStaffProfileIds && visibleStaffProfileIds.length === 0) {
    return { ok: true, permissionLevel: level, staff: [], canDelete: false };
  }

  const rows = await db
    .select({
      profile: staffProfiles,
      role: academyMemberships.role,
      academyWide: academyMemberships.academyWide,
      loginEmail: users.email,
    })
    .from(staffProfiles)
    .innerJoin(users, eq(users.id, staffProfiles.userId))
    .leftJoin(
      academyMemberships,
      and(
        eq(academyMemberships.userId, staffProfiles.userId),
        eq(academyMemberships.academyId, staffProfiles.academyId),
        // A membership `removeStaffMembership` set to "removed" must stop
        // showing that person's old role here — the leftJoin simply finds
        // no active membership row for them (row.role comes back null),
        // same as the pre-existing "no membership row at all" case, rather
        // than silently still reporting stale access.
        eq(academyMemberships.status, "active"),
      ),
    )
    .where(
      visibleStaffProfileIds
        ? and(
            eq(staffProfiles.academyId, access.academyId),
            inArray(staffProfiles.id, visibleStaffProfileIds),
          )
        : eq(staffProfiles.academyId, access.academyId),
    );

  const staffProfileIds = rows.map((row) => row.profile.id);
  const [referenceCountsByProfileId, assignmentRows, viewerBranchIds] = await Promise.all([
    countStaffReferencesBulk(staffProfileIds),
    staffProfileIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            staffProfileId: staffBranchAssignments.staffProfileId,
            id: branches.id,
            name: branches.name,
            isMain: branches.isMain,
          })
          .from(staffBranchAssignments)
          .innerJoin(branches, eq(branches.id, staffBranchAssignments.branchId))
          .where(
            and(
              eq(staffBranchAssignments.academyId, access.academyId),
              eq(branches.academyId, access.academyId),
              inArray(staffBranchAssignments.staffProfileId, staffProfileIds),
            ),
          )
          .orderBy(desc(branches.isMain), asc(branches.name)),
    scope.academyWide ? Promise.resolve(null) : getAssignedBranchIds(db, access.academyId, actorContext.userId),
  ]);
  const viewerBranches = viewerBranchIds ? new Set(viewerBranchIds) : null;
  const branchesByProfileId = new Map<string, { visible: StaffListRow["branches"]; hidden: number }>();
  for (const { staffProfileId, ...branch } of assignmentRows) {
    const entry = branchesByProfileId.get(staffProfileId) ?? { visible: [], hidden: 0 };
    if (!viewerBranches || viewerBranches.has(branch.id)) entry.visible.push(branch);
    else entry.hidden += 1;
    branchesByProfileId.set(staffProfileId, entry);
  }

  return {
    ok: true,
    permissionLevel: level,
    canDelete: canManageStaff(level) && scope.academyWide,
    staff: rows.map((row) => {
      const referenceCounts = referenceCountsByProfileId.get(row.profile.id) ?? {
        instructorCourseCount: 0,
        trainerAssignmentCount: 0,
        timetableCount: 0,
      };
      // The join above only ever surfaces an *active* membership's role
      // (see its own comment) — so `role !== null` here already means
      // "this person currently has active academy access," with no extra
      // query needed.
      const reasons = buildStaffDeletionReasons({ hasActiveMembership: row.role !== null, ...referenceCounts });
      const placed = branchesByProfileId.get(row.profile.id) ?? { visible: [], hidden: 0 };
      const isOwner = row.role === "academy_owner";
      const holdsGrant = row.role !== null && !isOwner && row.academyWide === true;
      return {
        ...toRecord(row.profile),
        role: row.role,
        loginEmail: row.loginEmail,
        allBranchAccess: isOwner || holdsGrant,
        branches: placed.visible,
        otherBranchCount: placed.hidden,
        // Only the owner changes where someone with all-branch access works;
        // a branch-limited viewer only staff in one of their branches.
        canEditBranches:
          canManageStaff(level) &&
          row.role !== null &&
          !isOwner &&
          (!holdsGrant || scope.membershipRole === "academy_owner") &&
          (scope.academyWide || placed.visible.length > 0),
        deletionEligibility: { eligible: reasons.length === 0, reasons },
      };
    }),
  };
}

/**
 * ---------------------------------------------------------------------
 * Permanent staff deletion — narrow, eligibility-gated, distinct from the
 * archive/restore status toggle AND from removeStaffMembership
 * ---------------------------------------------------------------------
 * Direct inbound FKs to `staffProfiles` (lib/db/schema.ts):
 * staffBranchAssignments, staffDocuments, courses.instructorId (nullable),
 * batchTrainerAssignments, timetables.trainerStaffProfileId (nullable).
 * `staffProfiles` has NO FK to `academy_memberships` (they're independent
 * siblings joined only at query time by (academy_id, user_id) — see
 * `listStaff`'s own join) — but a `staffProfiles` row can never be deleted
 * while an ACTIVE `academy_memberships` row still exists for the same
 * user+academy. This is the load-bearing rule this task explicitly asks
 * for ("Deletion of a staff profile must NOT be used as a shortcut for
 * revoking academy access"): it forces every deletion through the existing
 * `removeStaffMembership` first, which already enforces "an owner-only
 * actor may remove an owner" and "never remove the last remaining owner" —
 * so `deleteStaff` never needs to re-implement those checks itself, and an
 * `academy_owner` (or the last remaining owner) can never be deleted while
 * their membership is still active.
 *
 * courses.instructorId and batchTrainerAssignments/timetables references
 * are treated as protected — this codebase never silently mutates a live
 * course/timetable row's FK as a side effect of an unrelated staff
 * deletion (that would itself be a "cascade" this task explicitly
 * forbids), so any of these existing simply blocks deletion until the
 * caller reassigns/clears them first.
 *
 * staffBranchAssignments/staffDocuments are treated as safely disposable —
 * pure branch-assignment/document metadata with no standalone value once
 * the profile itself is gone, same judgment lib/academies/delete-academy.ts
 * already made for these exact two tables at the whole-academy scale.
 * `users` is never touched — a user account is shared across every
 * academy that person has ever staffed (staff_profiles' own unique
 * (academy_id, user_id) constraint proves one user can hold profiles in
 * several academies), so deleting one academy's staff_profiles row must
 * never delete or affect the global `users` row.
 */
export interface StaffDeletionEligibility {
  staffProfileId: string;
  staffName: string;
  eligible: boolean;
  reasons: string[];
  hasActiveMembership: boolean;
  instructorCourseCount: number;
  trainerAssignmentCount: number;
  timetableCount: number;
}

export type GetStaffDeletionEligibilityResult =
  | { ok: true; eligibility: StaffDeletionEligibility }
  | { ok: false; error: StaffActionError };

type StaffReferenceCounts = {
  instructorCourseCount: number;
  trainerAssignmentCount: number;
  timetableCount: number;
};

/** Bulk per-profile instructor/trainer/timetable reference counts, for the
 * staff list's Delete button — three grouped queries for the whole
 * visible list rather than N+1. `hasActiveMembership` is deliberately not
 * computed here — `listStaff`'s own join already surfaces it for free
 * (an active membership's role, or `null`), so no query is duplicated. */
async function countStaffReferencesBulk(staffProfileIds: string[]): Promise<Map<string, StaffReferenceCounts>> {
  if (staffProfileIds.length === 0) return new Map();
  const [instructorRows, trainerRows, timetableRows] = await Promise.all([
    db.select({ staffProfileId: courses.instructorId, count: sql<number>`count(*)::int` }).from(courses).where(inArray(courses.instructorId, staffProfileIds)).groupBy(courses.instructorId),
    db.select({ staffProfileId: batchTrainerAssignments.staffProfileId, count: sql<number>`count(*)::int` }).from(batchTrainerAssignments).where(inArray(batchTrainerAssignments.staffProfileId, staffProfileIds)).groupBy(batchTrainerAssignments.staffProfileId),
    db.select({ staffProfileId: timetables.trainerStaffProfileId, count: sql<number>`count(*)::int` }).from(timetables).where(inArray(timetables.trainerStaffProfileId, staffProfileIds)).groupBy(timetables.trainerStaffProfileId),
  ]);
  const instructorByProfile = new Map(instructorRows.filter((r) => r.staffProfileId !== null).map((r) => [r.staffProfileId as string, r.count]));
  const trainerByProfile = new Map(trainerRows.map((r) => [r.staffProfileId, r.count]));
  const timetableByProfile = new Map(timetableRows.filter((r) => r.staffProfileId !== null).map((r) => [r.staffProfileId as string, r.count]));

  const result = new Map<string, StaffReferenceCounts>();
  for (const staffProfileId of staffProfileIds) {
    result.set(staffProfileId, {
      instructorCourseCount: instructorByProfile.get(staffProfileId) ?? 0,
      trainerAssignmentCount: trainerByProfile.get(staffProfileId) ?? 0,
      timetableCount: timetableByProfile.get(staffProfileId) ?? 0,
    });
  }
  return result;
}

async function countStaffDependents(
  executor: DbClient,
  academyId: string,
  staffProfileId: string,
  userId: string,
): Promise<{
  hasActiveMembership: boolean;
  instructorCourseCount: number;
  trainerAssignmentCount: number;
  timetableCount: number;
}> {
  const [[membershipRow], [instructorRow], [trainerRow], [timetableRow]] = await Promise.all([
    executor
      .select({ id: academyMemberships.id })
      .from(academyMemberships)
      .where(
        and(
          eq(academyMemberships.userId, userId),
          eq(academyMemberships.academyId, academyId),
          eq(academyMemberships.status, "active"),
        ),
      )
      .limit(1),
    executor.select({ count: sql<number>`count(*)::int` }).from(courses).where(eq(courses.instructorId, staffProfileId)),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(batchTrainerAssignments)
      .where(eq(batchTrainerAssignments.staffProfileId, staffProfileId)),
    executor.select({ count: sql<number>`count(*)::int` }).from(timetables).where(eq(timetables.trainerStaffProfileId, staffProfileId)),
  ]);
  return {
    hasActiveMembership: Boolean(membershipRow),
    instructorCourseCount: instructorRow?.count ?? 0,
    trainerAssignmentCount: trainerRow?.count ?? 0,
    timetableCount: timetableRow?.count ?? 0,
  };
}

function buildStaffDeletionReasons(counts: {
  hasActiveMembership: boolean;
  instructorCourseCount: number;
  trainerAssignmentCount: number;
  timetableCount: number;
}): string[] {
  const reasons: string[] = [];
  if (counts.hasActiveMembership) {
    reasons.push(
      "this person still has active academy access — remove their access first (Remove access)",
    );
  }
  if (counts.instructorCourseCount > 0) {
    reasons.push(
      `assigned as instructor to ${counts.instructorCourseCount} course${counts.instructorCourseCount === 1 ? "" : "s"}`,
    );
  }
  if (counts.trainerAssignmentCount > 0) {
    reasons.push(
      `assigned as trainer to ${counts.trainerAssignmentCount} batch${counts.trainerAssignmentCount === 1 ? "" : "es"}`,
    );
  }
  if (counts.timetableCount > 0) {
    reasons.push(
      `referenced in ${counts.timetableCount} timetable ${counts.timetableCount === 1 ? "entry" : "entries"}`,
    );
  }
  return reasons;
}

/** Read-only preview for the UI's Delete button — `deleteStaff` below
 * re-runs the identical check itself, inside the deletion transaction, as
 * the actual authority. */
export async function getStaffDeletionEligibility(
  actorContext: AuthContext,
  staffProfileId: string,
): Promise<GetStaffDeletionEligibilityResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (!canManageStaff(level)) {
    return { ok: false, error: FORBIDDEN };
  }
  if (!access.academyWide) {
    return { ok: false, error: { code: "forbidden", message: "Only someone with access to all branches can permanently delete a staff member." } };
  }

  const parsedId = z.string().uuid().safeParse(staffProfileId);
  if (!parsedId.success) {
    return { ok: false, error: { code: "not_found", message: "Staff member not found." } };
  }

  const [profile] = await db
    .select({ id: staffProfiles.id, fullName: staffProfiles.fullName, userId: staffProfiles.userId })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.id, staffProfileId), eq(staffProfiles.academyId, access.academyId)))
    .limit(1);
  if (!profile) {
    return { ok: false, error: { code: "not_found", message: "Staff member not found." } };
  }

  const counts = await countStaffDependents(db, access.academyId, profile.id, profile.userId);
  const reasons = buildStaffDeletionReasons(counts);

  return {
    ok: true,
    eligibility: {
      staffProfileId: profile.id,
      staffName: profile.fullName,
      eligible: reasons.length === 0,
      reasons,
      ...counts,
    },
  };
}

export type DeleteStaffResult =
  | { ok: true; staffProfileId: string }
  | { ok: false; error: StaffActionError };

/**
 * Eligibility is re-verified from scratch INSIDE this transaction, on a
 * row locked with `for("update")` — an assignment could be created, or
 * access re-granted, between the UI's preview and this call, and this is
 * the check that actually decides whether the delete proceeds. Audited
 * before the row is removed, same convention as deleteAcademy/deleteExam/
 * deleteProgram/deleteCourse/deleteBatch/deleteStudent.
 */
export async function deleteStaff(
  actorContext: AuthContext,
  staffProfileId: string,
  confirmedName: string,
): Promise<DeleteStaffResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (!canManageStaff(level)) {
    return { ok: false, error: FORBIDDEN };
  }
  if (!access.academyWide) {
    return { ok: false, error: { code: "forbidden", message: "Only someone with access to all branches can permanently delete a staff member." } };
  }

  const parsedId = z.string().uuid().safeParse(staffProfileId);
  if (!parsedId.success) {
    return { ok: false, error: { code: "not_found", message: "Staff member not found." } };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(staffProfiles)
      .where(and(eq(staffProfiles.id, staffProfileId), eq(staffProfiles.academyId, access.academyId)))
      .for("update");
    if (!existing) {
      return { ok: false, error: { code: "not_found", message: "Staff member not found." } };
    }

    // Re-checked against the row's CURRENT full name, under the same
    // lock — never trusts a name the caller fetched earlier via the
    // eligibility preview, same convention as
    // lib/academies/delete-academy.ts's deleteAcademy.
    if (confirmedName !== existing.fullName) {
      return {
        ok: false,
        error: { code: "validation", message: "Type the exact staff member's name to confirm permanent deletion." },
      };
    }

    const counts = await countStaffDependents(tx, access.academyId, existing.id, existing.userId);
    const reasons = buildStaffDeletionReasons(counts);
    if (reasons.length > 0) {
      return {
        ok: false,
        error: {
          code: "ineligible",
          message: `This staff member cannot be permanently deleted because ${reasons.join(", ")}. Archive them instead.`,
        },
      };
    }

    // `toRecord`'s `email` field is staff_profiles' own optional contact
    // email — a separate column from the account's actual sign-in email
    // (users.email, only ever joined in at query time by listStaff). Once
    // this row is gone, that join can never happen again, so the login
    // email must be captured explicitly here or it's lost forever — the
    // one piece of "who was this" information an admin reviewing the audit
    // trail afterward would actually search for.
    const [user] = await tx.select({ loginEmail: users.email }).from(users).where(eq(users.id, existing.userId)).limit(1);

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: access.membershipRole,
        academyId: access.academyId,
        action: "deleteStaff",
        entityType: "staff_profile",
        entityId: staffProfileId,
        before: { ...toRecord(existing), loginEmail: user?.loginEmail ?? null },
      },
      tx,
    );

    // Disposable dependent data only — guaranteed by the eligibility check
    // above that no active membership/instructor/trainer/timetable
    // reference exists. `users` is never touched (see this function's own
    // module comment).
    await tx.delete(staffBranchAssignments).where(eq(staffBranchAssignments.staffProfileId, staffProfileId));
    await tx.delete(staffDocuments).where(eq(staffDocuments.staffProfileId, staffProfileId));
    await tx.delete(staffProfiles).where(eq(staffProfiles.id, staffProfileId));

    return { ok: true, staffProfileId };
  });
}
