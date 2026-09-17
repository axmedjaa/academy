import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { branches, staffBranchAssignments, staffProfiles, students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_STUDENTS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { checkAllowance, type UsageActionError } from "@/lib/subscriptions/usage";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 2, Item 38 — "`generateStudentId` + `registerStudent` +
 * `checkAllowance('students')` + cross-tenant/duplicate-ID tests."
 *
 * Gating follows lib/academies/branches.ts's / lib/academies/staff.ts's
 * exact template: resolve academy+role via `checkAcademyAccessForContext`
 * (never a client-supplied academyId), then consult
 * lib/auth/academy-permissions.ts for the row this item adds
 * (`"academy.students"`). Master Permission Matrix "Students / admissions"
 * row: Full(owner)/Full(admin)/Manage(manager)/Manage(admissions_officer)/
 * View(finance_officer)/"View assigned"(trainer), scope "assigned" for the
 * two branch-limited roles (Admissions Officer, Trainer — same
 * `BRANCH_LIMITED_ROLES` set as branches.ts, per Phase 2 §6's own wording:
 * "Admissions Officer is branch-limited specifically because admissions/
 * registration work is inherently tied to the branch a student is walking
 * into").
 *
 * `ACADEMY_STUDENTS_ACTION` itself lives in lib/auth/academy-permissions.ts
 * (this item's one additive row there) — re-exported by neither this file
 * nor any other; a later item (search/update, admissions view) should
 * import it directly from that module, same convention
 * `ACADEMY_STAFF_ACTION` already follows.
 *
 * Only Owner/Admin/Manager/Admissions Officer (full or manage) may
 * *register* a student — Finance Officer and Trainer both sit at "view"
 * on this row (Trainer's cell is literally "View assigned", not a
 * create-capable level) and are refused here, even though Trainer can
 * presumably view students elsewhere (a later item's list/search
 * concern, out of this item's scope). Admissions Officer, despite having
 * "manage", is still branch-limited: they may only register a student
 * into one of their own assigned branches (staff_branch_assignments) —
 * enforced below by rejecting any other branchId with the same IDOR-safe
 * "not_found" convention branches.ts already uses for a branch-limited
 * role hitting an unassigned branch (never a distinguishing "forbidden",
 * which would itself confirm the branch exists).
 */
// Same branch-limited role set as lib/academies/branches.ts (kept as its
// own copy here rather than imported/exported from that file — it is a
// read-only reference per this item's brief, not a shared module to
// extend).
const BRANCH_LIMITED_ROLES: ReadonlySet<AcademyRole> = new Set([
  "admissions_officer",
  "trainer",
]);

function isBranchLimited(role: AcademyRole): boolean {
  return BRANCH_LIMITED_ROLES.has(role);
}

function canRegister(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

export interface RegisterStudentActionError {
  code: "forbidden" | "validation" | "blocked" | "not_found" | "allowance" | "conflict";
  message: string;
}

const FORBIDDEN: RegisterStudentActionError = {
  code: "forbidden",
  message: "You don't have permission to register students for this academy.",
};

// Same generic-message IDOR-safety convention as branches.ts's NOT_FOUND:
// "branch doesn't exist", "branch belongs to another academy", and
// "branch exists but isn't assigned to this branch-limited caller" must
// all be indistinguishable to the caller.
const BRANCH_NOT_FOUND: RegisterStudentActionError = {
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

export const registerStudentSchema = z.object({
  branchId: z.string().uuid("Select a branch"),
  fullName: z.string().trim().min(1, "Full name is required").max(200),
  // PLAN.md's literal column is `date_of_birth date nullable` — same
  // plain "YYYY-MM-DD" string convention as staff.ts's hireDate (no
  // separate Date-object parsing layer exists anywhere in this repo for a
  // `date`, as opposed to `timestamp`, column).
  dateOfBirth: optionalText(20),
  gender: optionalText(50),
  phone: optionalText(50),
  email: optionalEmail(),
  guardianName: optionalText(200),
  guardianPhone: optionalText(50),
});

export type RegisterStudentInput = z.input<typeof registerStudentSchema>;

export interface StudentRecord {
  id: string;
  academyId: string;
  branchId: string;
  studentNumber: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: string | null;
  phone: string | null;
  email: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  status: "active" | "archived";
  createdBy: string;
}

function toRecord(row: typeof students.$inferSelect): StudentRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    branchId: row.branchId,
    studentNumber: row.studentNumber,
    fullName: row.fullName,
    dateOfBirth: row.dateOfBirth,
    gender: row.gender,
    phone: row.phone,
    email: row.email,
    guardianName: row.guardianName,
    guardianPhone: row.guardianPhone,
    status: row.status,
    createdBy: row.createdBy,
  };
}

/**
 * Same join pattern as lib/academies/branches.ts's private
 * `getAssignedBranchIds` (read-only reference, not imported — that
 * function isn't exported and this file's brief says to reuse the
 * *pattern*, not the module): resolve the caller's staff_profiles row for
 * this academy, then its staff_branch_assignments. No staff_profiles row
 * (or zero assignments) means "assigned to nothing" — an empty list, not
 * an error.
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

interface ResolvedStudentAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveStudentAccessResult =
  | { ok: true; access: ResolvedStudentAccess }
  | { ok: false; error: RegisterStudentActionError };

async function resolveStudentAccess(
  actorContext: AuthContext,
): Promise<ResolveStudentAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(
    access.membershipRole,
    ACADEMY_STUDENTS_ACTION,
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

/**
 * Postgres unique_violation (23505) detection — identical shape to
 * lib/academies/branches.ts's `isUniqueViolation`, duplicated here per
 * that file's own documented convention (each academy-scoped action file
 * keeps its own copy rather than importing a private helper from a
 * sibling): drizzle-orm wraps the raw `pg` DatabaseError inside its own
 * `DrizzleQueryError`, so the real `code` lives on `err.cause`, not on
 * `err` itself — checked at both levels defensively.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

function formatStudentNumber(sequence: number): string {
  return `STD-${String(sequence).padStart(6, "0")}`;
}

const MAX_CANDIDATE_SCAN_ATTEMPTS = 1000;

/**
 * PLAN.md §4: `generateStudentId` — an academy-scoped sequential numbering
 * scheme (`STD-000001`, `STD-000002`, ...) that's independent per academy
 * (two academies can both reach `STD-000001`, per §8/§9's acceptance
 * criteria). "Count existing + 1" is the starting candidate — same
 * approach register.ts's `findAvailableSlug` uses for academy slugs — and,
 * also like that function, this does a bounded best-effort scan forward
 * past any candidate that already exists (defensive against gaps left by
 * archived-but-still-numbered students or a prior failed attempt), rather
 * than trusting the count alone the way a racy `SELECT MAX(...) + 1` would
 * (Concurrency & Idempotency: "a DB sequence or unique-constraint-with-
 * retry — never a racy SELECT MAX(...) + 1").
 *
 * This function's own scan is still just a best-effort pre-check (like
 * `findAvailableSlug`'s) — the real safety net against a genuine
 * concurrent race for the *same* candidate is the
 * `(academy_id, student_number)` DB-level unique constraint, enforced at
 * insert time by `registerStudent`'s retry loop below, which re-calls this
 * function and re-attempts the insert on a caught 23505 rather than
 * assuming the first candidate this function returns is guaranteed to
 * still be free by the time the insert runs.
 */
export async function generateStudentId(
  executor: DbClient,
  academyId: string,
): Promise<string> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(students)
    .where(eq(students.academyId, academyId));

  let sequence = (row?.count ?? 0) + 1;

  for (let attempt = 0; attempt < MAX_CANDIDATE_SCAN_ATTEMPTS; attempt += 1) {
    const candidate = formatStudentNumber(sequence);
    const [existing] = await executor
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.academyId, academyId), eq(students.studentNumber, candidate)))
      .limit(1);
    if (!existing) return candidate;
    sequence += 1;
  }

  // Effectively unreachable — see findAvailableSlug's identical fallback.
  return formatStudentNumber(sequence);
}

class AllowanceLimitReached extends Error {
  constructor(
    public readonly current: number,
    public readonly limit: number,
  ) {
    super("Student allowance limit reached.");
  }
}

class AllowanceCheckFailure extends Error {
  constructor(public readonly usageError: UsageActionError) {
    super(usageError.message);
  }
}

class BranchNotFoundSignal extends Error {}

// Generous on purpose: each attempt is a full fresh transaction (see
// registerStudent's module comment on why), and under heavy concurrent
// registration a losing transaction may need more than a couple of
// retries before its re-read of the count lands on a still-free
// candidate — empirically, 5 wasn't always enough at 8-way concurrency in
// this codebase's own test. A retry is cheap (no external side effect,
// nothing partially applied thanks to the full rollback), so erring high
// here costs little while making a spurious "conflict" failure under
// realistic concurrency effectively impossible.
const MAX_INSERT_ATTEMPTS = 20;

export type RegisterStudentResult =
  | { ok: true; student: StudentRecord }
  | { ok: false; error: RegisterStudentActionError };

/**
 * PLAN.md §4: `registerStudent` (`checkAllowance('students')`). Only
 * "full"/"manage" (Owner, Admin, Manager, Admissions Officer) may
 * register; "view" (Finance Officer, Trainer) is refused here even though
 * Trainer/Finance have some visibility into this row elsewhere, matching
 * the exact Full/Full/Manage/Manage/View/View split branches.ts's
 * createBranch already established for its own row.
 *
 * Admissions Officer is additionally branch-limited (§6): the target
 * branchId must both belong to this academy AND (for a branch-limited
 * role) be one of the caller's assigned branches, or the action fails
 * with the same generic `not_found` a nonexistent/cross-academy branchId
 * would — never a distinguishing `forbidden` that would confirm the
 * branch exists.
 *
 * ---------------------------------------------------------------------
 * Why the retry loop wraps a *fresh* transaction each attempt, not a
 * single transaction retried internally
 * ---------------------------------------------------------------------
 * Verified empirically against the real local Postgres this codebase
 * targets (not assumed): once one statement inside a transaction fails
 * (e.g. the `(academy_id, student_number)` unique-violation this loop is
 * built to survive), Postgres marks that entire transaction aborted —
 * `25P02, "current transaction is aborted, commands ignored until end of
 * transaction block"` — for every subsequent statement, even ones that
 * would otherwise succeed and even though the JS `catch` around the
 * failed `insert` swallows the error. A caught unique-violation therefore
 * can *not* be retried with another `insert` call inside that same
 * `tx` — only a full `ROLLBACK` (which committing/throwing out of
 * `db.transaction`'s callback triggers automatically) clears the aborted
 * state. So each attempt below opens its own `db.transaction`: on a
 * losing race, that whole attempt's transaction rolls back cleanly and
 * the next attempt starts a brand-new one, whose own `checkAllowance` +
 * `generateStudentId` re-reads now see the winning attempt's committed
 * row — which is exactly what makes the fresh candidate on the next
 * attempt collision-free in practice. (Re-deriving the branch/branch-
 * scope checks on every attempt is cheap and idempotent, so redoing them
 * per attempt costs nothing beyond the retry itself.)
 */
export async function registerStudent(
  actorContext: AuthContext,
  input: RegisterStudentInput,
): Promise<RegisterStudentResult> {
  const resolved = await resolveStudentAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canRegister(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = registerStudentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt += 1) {
    try {
      const row = await db.transaction(async (tx) => {
        const [branch] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.id, data.branchId), eq(branches.academyId, academyId)))
          .limit(1);
        if (!branch) {
          throw new BranchNotFoundSignal();
        }

        if (isBranchLimited(membershipRole)) {
          const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
          if (!assignedIds.includes(data.branchId)) {
            throw new BranchNotFoundSignal();
          }
        }

        const allowance = await checkAllowance(academyId, "students", tx);
        if (!allowance.ok) {
          throw new AllowanceCheckFailure(allowance.error);
        }
        if (!allowance.result.allowed) {
          throw new AllowanceLimitReached(allowance.result.current, allowance.result.limit);
        }

        const studentNumber = await generateStudentId(tx, academyId);
        const [inserted] = await tx
          .insert(students)
          .values({
            academyId,
            branchId: data.branchId,
            studentNumber,
            fullName: data.fullName,
            dateOfBirth: data.dateOfBirth,
            gender: data.gender,
            phone: data.phone,
            email: data.email,
            guardianName: data.guardianName,
            guardianPhone: data.guardianPhone,
            createdBy: actorContext.userId,
          })
          .returning();

        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: membershipRole,
            academyId,
            action: "registerStudent",
            entityType: "student",
            entityId: inserted.id,
            branchId: inserted.branchId,
            after: toRecord(inserted),
          },
          tx,
        );

        return inserted;
      });

      return { ok: true, student: toRecord(row) };
    } catch (err) {
      if (err instanceof BranchNotFoundSignal) {
        return { ok: false, error: BRANCH_NOT_FOUND };
      }
      if (err instanceof AllowanceLimitReached) {
        return {
          ok: false,
          error: {
            code: "allowance",
            message: `This academy has reached its plan's student limit (${err.current}/${err.limit}). Archive an existing student or upgrade the plan to register another.`,
          },
        };
      }
      if (err instanceof AllowanceCheckFailure) {
        return { ok: false, error: { code: "validation", message: err.usageError.message } };
      }
      if (isUniqueViolation(err)) {
        if (attempt < MAX_INSERT_ATTEMPTS - 1) {
          continue;
        }
        return {
          ok: false,
          error: {
            code: "conflict",
            message: "Could not generate a unique student ID after several attempts.",
          },
        };
      }
      throw err;
    }
  }

  // Unreachable: the loop above always either returns or continues, and
  // the final iteration's conflict branch returns instead of continuing.
  throw new Error("registerStudent: exhausted retry attempts unexpectedly.");
}
