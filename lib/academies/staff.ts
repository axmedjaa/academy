import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { academyMemberships, staffBranchAssignments, staffProfiles, users } from "@/lib/db/schema";
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
    | "conflict";
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
});

export type CreateStaffInput = z.input<typeof createStaffSchema>;

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
      if (existingUser) {
        userId = existingUser.id;

        const [existingProfile] = await tx
          .select({ id: staffProfiles.id })
          .from(staffProfiles)
          .where(
            and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, userId)),
          )
          .limit(1);
        const [existingMembership] = await tx
          .select({ id: academyMemberships.id })
          .from(academyMemberships)
          .where(
            and(
              eq(academyMemberships.academyId, academyId),
              eq(academyMemberships.userId, userId),
            ),
          )
          .limit(1);
        if (existingProfile || existingMembership) {
          throw new AlreadyStaff();
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

      await tx.insert(academyMemberships).values({
        userId,
        academyId,
        role: data.role,
        status: "active",
      });

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
          after: { ...toRecord(profile), role: data.role, email: data.email },
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

  const parsedRole = z.enum(ACADEMY_ROLES).safeParse(role);
  if (!parsedRole.success) {
    return { ok: false, error: { code: "validation", message: "Invalid role." } };
  }

  const result = await db.transaction(async (tx) => {
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
    if (!existing) return null;

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

    return updated;
  });

  if (!result) {
    return {
      ok: false,
      error: { code: "not_found", message: "This user is not a staff member of this academy." },
    };
  }
  return { ok: true, userId: result.userId, role: result.role };
}

export type RemoveStaffMembershipResult = { ok: true } | { ok: false; error: StaffActionError };

/**
 * The actual "remove access" lib/db/schema.ts's own `membershipStatusEnum`
 * comment has always described ("Removing an academy membership revokes
 * that user's active sessions for that academy context") but that no code
 * ever wrote until now — `updateStaff`'s status toggle only ever flips
 * `staff_profiles.status`, a separate column recording employment record
 * state, never `academy_memberships.status`, so an "archived" staff member
 * kept full academy login access under the pre-existing code. This is the
 * "delete" for staff membership: never a hard row delete (audit rows, exam
 * results, payments, etc. recorded under this person's `user_id` must stay
 * resolvable) — a status flip to `"removed"`, the exact same soft-removal
 * shape every other entity in this codebase already uses (branches/
 * courses/batches/programs `status: archived`, certificates
 * `status: cancelled`, ...).
 *
 * Owner-safety: removing an `academy_owner` membership requires the actor
 * to already be an owner, and is refused if it would leave zero active
 * owners. There is no ownership-transfer action in this codebase to point
 * someone at instead — assignStaffRole already IS that transfer (promote a
 * successor to `academy_owner`, then remove the original).
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

    await tx
      .update(academyMemberships)
      .set({ status: "removed" })
      .where(eq(academyMemberships.id, existing.id));

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: access.membershipRole,
        academyId: access.academyId,
        action: "removeStaffMembership",
        entityType: "academy_membership",
        entityId: existing.id,
        before: { status: existing.status, role: existing.role },
        after: { status: "removed" },
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
}

export type ListStaffResult =
  | { ok: true; staff: StaffListRow[]; permissionLevel: AcademyPermissionLevel }
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
export async function listStaff(actorContext: AuthContext): Promise<ListStaffResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (!canViewStaff(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  let visibleStaffProfileIds: string[] | null = null;
  if (!canManageStaff(level)) {
    // "view" is the only remaining non-"none" level today (Trainer) — see
    // this function's own doc comment.
    visibleStaffProfileIds = await getViewableStaffProfileIds(
      access.academyId,
      actorContext.userId,
    );
    if (visibleStaffProfileIds.length === 0) {
      return { ok: true, permissionLevel: level, staff: [] };
    }
  }

  const rows = await db
    .select({
      profile: staffProfiles,
      role: academyMemberships.role,
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

  return {
    ok: true,
    permissionLevel: level,
    staff: rows.map((row) => ({
      ...toRecord(row.profile),
      role: row.role,
      loginEmail: row.loginEmail,
    })),
  };
}
