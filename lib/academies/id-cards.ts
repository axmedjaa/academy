import { randomBytes } from "node:crypto";
import { and, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { staffBranchAssignments, staffProfiles, students, studentIdCards } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_STUDENT_ID_CARDS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 2, Item 40 — "`student_id_cards` migration + issue/reprint
 * actions."
 *
 * Gating follows lib/academies/branches.ts's (Item 34) exact template:
 * resolve academy+role via `checkAcademyAccessForContext` (never a
 * client-supplied academyId), then consult lib/auth/academy-permissions.ts
 * for the row this item adds (`"academy.student_id_cards"`). Master
 * Permission Matrix "Student ID cards" row: Full(owner)/Manage(admin)/
 * Manage(manager)/Manage(admissions_officer)/none(finance_officer)/
 * none(trainer), scope "assigned" for the two branch-limited roles.
 *
 * Unlike Branches' Full/Full/Manage/View/—/View split, this row has only
 * three distinct levels in play — full, manage, none — with no separate
 * "view" cell for anyone, so `permissionLevel !== "none"` is both "has any
 * access" and "may issue/reprint" for every role this table grants
 * anything to; there is no read-only role to additionally gate a
 * `canManage`-style boolean against (kept anyway, for parity with
 * branches.ts and in case a later item ever adds a view-only cell here).
 *
 * Trainer is listed as branch-limited in PLAN.md §6 alongside Admissions
 * Officer, but has permission level "none" on this specific row, so it
 * never reaches the branch-scoping check in practice; Admissions Officer
 * (the only branch-limited role with real access here, "manage") is the
 * one this file's branch-scoping/IDOR logic actually protects.
 */
export const ACADEMY_ID_CARDS_ACTION = ACADEMY_STUDENT_ID_CARDS_ACTION;

// Same branch-limited-roles set as lib/academies/branches.ts's
// BRANCH_LIMITED_ROLES (not exported there, so recreated here rather than
// touching that read-only file) — PLAN.md §6's "further by branch_id for
// branch-limited roles (Admissions Officer, Trainer)".
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

export interface IdCardActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict";
  message: string;
}

const FORBIDDEN: IdCardActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's student ID cards.",
};

// Same generic-message IDOR-safety convention as
// lib/academies/branches.ts's NOT_FOUND: "doesn't exist", "belongs to
// another academy", and "belongs to a student outside an
// admissions-officer/trainer's assigned branch" must all be
// indistinguishable to the caller, including via a guessed id.
const NOT_FOUND: IdCardActionError = {
  code: "not_found",
  message: "Student ID card not found.",
};

const STUDENT_NOT_FOUND: IdCardActionError = {
  code: "not_found",
  message: "Student not found.",
};

export interface IdCardRecord {
  id: string;
  academyId: string;
  studentId: string;
  cardNumber: string;
  photoFileRef: string | null;
  issuedAt: Date;
  issuedBy: string;
  reprintCount: number;
  status: "active" | "archived";
  createdAt: Date;
}

function toRecord(row: typeof studentIdCards.$inferSelect): IdCardRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    studentId: row.studentId,
    cardNumber: row.cardNumber,
    photoFileRef: row.photoFileRef,
    issuedAt: row.issuedAt,
    issuedBy: row.issuedBy,
    reprintCount: row.reprintCount,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/**
 * Same join pattern as lib/academies/branches.ts's (unexported)
 * getAssignedBranchIds — recreated here rather than importing, since that
 * file is read-only per this item's brief. A caller with no staff_profiles
 * row (or zero assignments) is assigned to nothing.
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

interface ResolvedIdCardAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveIdCardAccessResult =
  | { ok: true; access: ResolvedIdCardAccess }
  | { ok: false; error: IdCardActionError };

async function resolveIdCardAccess(
  actorContext: AuthContext,
): Promise<ResolveIdCardAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(
    access.membershipRole,
    ACADEMY_ID_CARDS_ACTION,
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
 * Resolves the student row this action targets, tenant- and (for
 * branch-limited roles) branch-scoped. IDOR-safe: a nonexistent id, a
 * different academy's student, and a student outside an assigned branch
 * all return the identical `STUDENT_NOT_FOUND` — same convention as
 * lib/academies/branches.ts's getBranch.
 *
 * Accepts either the student's UUID `id` OR their human-readable
 * `studentNumber` (e.g. "STD-E2E-A-001") — the only identifier
 * app/academy/students/students-list.tsx's "Student #" column actually
 * displays for copy/paste, so a raw UUID was never something a caller could
 * realistically have gotten from that page. `(academy_id, student_number)`
 * is a DB-level unique constraint (lib/db/schema.ts), so the studentNumber
 * branch is exactly as tenant-scoped and exact-match as the id branch —
 * this is not a fuzzier search, still exactly one row or none. Matched
 * case-insensitively (ilike, no wildcards) since studentNumber is always
 * generated uppercase but a person retyping it may not preserve case.
 */
async function resolveScopedStudent(
  executor: DbClient,
  academyId: string,
  membershipRole: AcademyRole,
  userId: string,
  studentIdOrNumber: string,
): Promise<{ id: string; branchId: string } | null> {
  const trimmed = studentIdOrNumber.trim();
  if (trimmed.length === 0) return null;

  const isUuid = z.string().uuid().safeParse(trimmed).success;

  const [row] = await executor
    .select({ id: students.id, branchId: students.branchId })
    .from(students)
    .where(
      and(
        eq(students.academyId, academyId),
        isUuid ? eq(students.id, trimmed) : ilike(students.studentNumber, trimmed),
      ),
    )
    .limit(1);
  if (!row) return null;

  if (isBranchLimited(membershipRole)) {
    const assignedIds = await getAssignedBranchIds(executor, academyId, userId);
    if (!assignedIds.includes(row.branchId)) return null;
  }

  return row;
}

/**
 * card_number generation, PLAN.md's own suggested pattern ("card numbers
 * should probably be generated similarly to generateStudentId ... retry-on-
 * conflict, not just checked-then-inserted"). Random rather than
 * sequential — unlike students.student_number (unique only *within* an
 * academy, so a per-academy counter makes sense), card_number is a single
 * *global* unique constraint (Database Constraints & Indexes:
 * "student_id_cards.card_number unique", no academy qualifier — see
 * schema.ts's comment on this table), so a global sequential counter would
 * need its own coordinated-counter table just to avoid the exact race this
 * function is designed to tolerate instead. 10 characters from a
 * 32-symbol alphabet (Crockford-ish, no 0/O/1/I to avoid transcription
 * errors on a physical printed card) is ~1.1e15 possible values — collision
 * likelihood on any single attempt is negligible, and issueStudentIdCard
 * still retries on the rare real 23505 rather than assuming it can't
 * happen.
 */
const CARD_NUMBER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CARD_NUMBER_LENGTH = 10;

export function generateCardNumber(): string {
  const bytes = randomBytes(CARD_NUMBER_LENGTH);
  let code = "";
  for (let i = 0; i < CARD_NUMBER_LENGTH; i += 1) {
    code += CARD_NUMBER_ALPHABET[bytes[i] % CARD_NUMBER_ALPHABET.length];
  }
  return `IDC-${code}`;
}

/**
 * Postgres unique_violation (23505) detection, identical pattern to
 * lib/academies/branches.ts's isUniqueViolation() (the known-bug fix this
 * item's brief calls out): drizzle-orm wraps the raw `pg` DatabaseError in
 * its own `DrizzleQueryError`, so `code` lives on `err.cause`, not on `err`
 * itself — checked at both levels defensively.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

const MAX_CARD_NUMBER_ATTEMPTS = 10;

export const issueStudentIdCardSchema = z.object({
  // Accepts the UUID id or the human-readable studentNumber — see
  // resolveScopedStudent's own doc comment for why: the student list's
  // "Student #" column is the only identifier there is to copy/paste.
  studentId: z.string().trim().min(1, "Enter a student # or ID."),
  photoFileRef: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

export type IssueStudentIdCardInput = z.input<typeof issueStudentIdCardSchema>;

export type IssueIdCardResult =
  | { ok: true; card: IdCardRecord }
  | { ok: false; error: IdCardActionError };

/**
 * PLAN.md Item 40: `issueStudentIdCard`. Only "full"/"manage" callers may
 * issue (the only two non-"none" levels this row has, per the module
 * comment above). Each call always inserts a brand-new row — there is no
 * uniqueness constraint on student_id itself (only an index, per
 * schema.ts), so a student can accumulate more than one card over time
 * (e.g. a genuine replacement with a new card_number); re-printing the
 * *same* physical card (same card_number) is reprintStudentIdCard below,
 * a deliberately distinct action.
 *
 * card_number is generated and retried inside its own fresh transaction
 * per attempt (rather than a single outer transaction wrapping every
 * retry) so a 23505 from one attempt cannot poison a transaction another
 * attempt still needs to use — each attempt either fully commits (insert +
 * audit row, atomically) or fully rolls back before the next candidate is
 * tried.
 */
export async function issueStudentIdCard(
  actorContext: AuthContext,
  input: IssueStudentIdCardInput,
): Promise<IssueIdCardResult> {
  const resolved = await resolveIdCardAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = issueStudentIdCardSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const student = await resolveScopedStudent(
    db,
    academyId,
    membershipRole,
    actorContext.userId,
    data.studentId,
  );
  if (!student) {
    return { ok: false, error: STUDENT_NOT_FOUND };
  }

  const issuedAt = new Date();

  for (let attempt = 0; attempt < MAX_CARD_NUMBER_ATTEMPTS; attempt += 1) {
    const cardNumber = generateCardNumber();
    try {
      const result = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(studentIdCards)
          .values({
            academyId,
            studentId: student.id,
            cardNumber,
            photoFileRef: data.photoFileRef,
            issuedAt,
            issuedBy: actorContext.userId,
          })
          .returning();

        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: membershipRole,
            academyId,
            action: "issueStudentIdCard",
            entityType: "student_id_card",
            entityId: row.id,
            after: toRecord(row),
          },
          tx,
        );

        return row;
      });

      return { ok: true, card: toRecord(result) };
    } catch (err) {
      if (isUniqueViolation(err)) {
        continue;
      }
      throw err;
    }
  }

  return {
    ok: false,
    error: {
      code: "conflict",
      message: "Could not generate a unique card number. Please try again.",
    },
  };
}

export type ReprintIdCardResult =
  | { ok: true; card: IdCardRecord }
  | { ok: false; error: IdCardActionError };

/**
 * PLAN.md Item 40: `reprintStudentIdCard`. Increments `reprint_count` on
 * the existing row — `card_number` is never touched, per the task brief
 * ("reprint increments reprint_count without changing card_number"). Scoped
 * the same way as every other read/write in this file: tenant-scoped via
 * the card's own academy_id, and (for Admissions Officer) additionally
 * scoped to the underlying student's assigned branch via a join, since the
 * card row itself carries no branch_id.
 */
export async function reprintStudentIdCard(
  actorContext: AuthContext,
  cardId: string,
): Promise<ReprintIdCardResult> {
  const resolved = await resolveIdCardAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(cardId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ card: studentIdCards, branchId: students.branchId })
      .from(studentIdCards)
      .innerJoin(students, eq(studentIdCards.studentId, students.id))
      .where(and(eq(studentIdCards.id, cardId), eq(studentIdCards.academyId, academyId)))
      .limit(1);
    if (!existing) return null;

    if (isBranchLimited(membershipRole)) {
      const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
      if (!assignedIds.includes(existing.branchId)) return null;
    }

    const [updated] = await tx
      .update(studentIdCards)
      .set({ reprintCount: sql`${studentIdCards.reprintCount} + 1` })
      .where(eq(studentIdCards.id, cardId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "reprintStudentIdCard",
        entityType: "student_id_card",
        entityId: cardId,
        before: toRecord(existing.card),
        after: toRecord(updated),
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return { ok: false, error: NOT_FOUND };
  }
  return { ok: true, card: toRecord(result) };
}

export type CheckIdCardAccessResult =
  | { ok: true; membershipRole: AcademyRole; canManage: boolean }
  | { ok: false; error: IdCardActionError };

/**
 * Page-gating helper for `/academy/id-cards` (app/academy/id-cards/page.tsx)
 * — same "resolve access, hand the page a canManage boolean" shape as
 * lib/academies/branches.ts's listBranches, but this row has no list
 * action of its own to piggyback the check on (issue/reprint/getIdCard are
 * all single-student lookups, per this item's file list), so this small
 * wrapper around resolveIdCardAccess exists purely so the page can decide
 * whether to render the lookup-and-issue UI at all before a studentId is
 * even known.
 */
export async function checkIdCardAccess(
  actorContext: AuthContext,
): Promise<CheckIdCardAccessResult> {
  const resolved = await resolveIdCardAccess(actorContext);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    membershipRole: resolved.access.membershipRole,
    canManage: canManage(resolved.access.permissionLevel),
  };
}

export type GetIdCardResult =
  | { ok: true; studentId: string; card: IdCardRecord | null }
  | { ok: false; error: IdCardActionError };

/**
 * Single-student read: the most recently issued card for that student (or
 * `null` if none has been issued yet), tenant- and branch-scoped the same
 * way issueStudentIdCard resolves its target student. Not a list of every
 * card the student has ever had — `/academy/id-cards`'s only documented
 * need (per this item's file list) is "does this student currently have a
 * card, and what does it say," which the latest row answers.
 *
 * Returns the resolved UUID `studentId` alongside the card, even when
 * `card` is null — the caller may have looked this up by studentNumber
 * (resolveScopedStudent accepts either), and the "use server" wrapper
 * (lib/academies/id-cards-actions.ts) needs the real UUID, never the raw
 * user-typed value, for its own by-id display-name lookup and for the
 * hidden field that feeds a subsequent "issue card" submission.
 */
export async function getIdCard(
  actorContext: AuthContext,
  studentId: string,
): Promise<GetIdCardResult> {
  const resolved = await resolveIdCardAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const student = await resolveScopedStudent(
    db,
    academyId,
    membershipRole,
    actorContext.userId,
    studentId,
  );
  if (!student) {
    return { ok: false, error: STUDENT_NOT_FOUND };
  }

  const rows = await db
    .select()
    .from(studentIdCards)
    .where(and(eq(studentIdCards.studentId, student.id), eq(studentIdCards.academyId, academyId)))
    .orderBy(sql`${studentIdCards.issuedAt} desc`)
    .limit(1);

  return { ok: true, studentId: student.id, card: rows[0] ? toRecord(rows[0]) : null };
}
