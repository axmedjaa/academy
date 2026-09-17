import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  approvalRequests,
  batches,
  examResults,
  exams,
  gradeBands,
  gradeConfigurations,
  students,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getAssignedBatchIds } from "@/lib/academies/batch-assignments";
import { createApprovalRequest, decideApprovalRequest } from "@/lib/academies/approval-requests";
import {
  ACADEMY_EXAMS_ACTION,
  ACADEMY_RESULTS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 3, Item 49 — "Result submit/approve/reject/publish flow
 * (`/academy/results`) + immutability test."
 *
 * ---------------------------------------------------------------------
 * Scope: what this item builds vs. what it deliberately does not
 * ---------------------------------------------------------------------
 * The Result Lifecycle table (PLAN.md, Lifecycle & State-Transition
 * Tables) has seven transitions. Item 48 (lib/academies/exams.ts, read-only
 * here) already built the first two ("— -> Draft" via `createExam`,
 * "Draft -> Marks Entered" via `enterMarks`). This item builds the next
 * four: "Marks Entered -> Submitted" (`submitResults`), "Submitted ->
 * Under Review" (automatic, folded into `submitResults` — see that
 * function's own comment for why no separate resting state is ever
 * observed), "Under Review -> Approved/Rejected" (`approveResult`/
 * `rejectResult`), and "Approved -> Published" (`publishResults`). The
 * final two rows ("Published -> Correction Requested" and onward) are
 * Item 50b, a separate later item this same wave also builds — see
 * lib/academies/result-corrections.ts, which reuses `approveResult`/
 * `rejectResult`'s underlying `decideApprovalRequest` plumbing but is not
 * itself part of this file.
 *
 * ---------------------------------------------------------------------
 * Naming: plural bulk actions vs. singular per-result actions
 * ---------------------------------------------------------------------
 * PLAN.md names `submitResults`/`publishResults` in the plural and
 * `approveResult`/`rejectResult` in the singular — not an accident,
 * modeled literally here: `submitResults`/`publishResults` operate on a
 * whole exam's roster at once (optionally narrowed to a `studentIds`
 * subset, mirroring `enterMarks`'s own "partial or full" shape from Item
 * 48), while `approveResult`/`rejectResult` decide exactly one
 * `exam_results` row (identified by its own id) — an approval decision is
 * inherently a per-student judgment (one student's marks might be
 * approved while another's are sent back), so there is no meaningful
 * "approve the whole exam at once" action for PLAN.md to have named in the
 * singular-vs-plural way it named the other two.
 *
 * ---------------------------------------------------------------------
 * Permission gating — two distinct rows, deliberately not one
 * ---------------------------------------------------------------------
 * `submitResults` is gated on the SAME row/level `enterMarks` uses
 * (`ACADEMY_EXAMS_ACTION`, `"enter_marks"` level or above) — per the
 * Result Lifecycle table's own words, "same actors as [enterMarks]." It is
 * NOT gated on the new `ACADEMY_RESULTS_ACTION` row at all. `canSubmit`
 * below mirrors lib/academies/exams.ts's private `canEnterMarksLevel`
 * exactly (full/manage/enter_marks) since that function isn't exported and
 * this file must not modify the read-only exams.ts to export it.
 *
 * `approveResult`/`rejectResult`/`publishResults` are gated on the NEW
 * `ACADEMY_RESULTS_ACTION` row (`"approve"` level — Owner/Admin/Manager
 * only, never Trainer). See lib/auth/academy-permissions.ts's
 * `ACADEMY_RESULTS_ACTION` comment for the full reasoning, including why
 * Trainer gets no entry on that row at all.
 *
 * Trainer-batch scoping for `submitResults` is the SAME
 * `batch_trainer_assignments`-via-`getAssignedBatchIds` mechanism
 * `enterMarks` uses (NOT branch-based) — see exams.ts's module comment for
 * why. `approveResult`/`rejectResult`/`publishResults` need no such scoping
 * since Trainer never reaches their gate at all.
 *
 * ---------------------------------------------------------------------
 * Approval-queue integration — Item 50a's `approval_requests`, reused
 * exactly like Item 47's grade-configuration flow
 * ---------------------------------------------------------------------
 * `submitResults` creates one `entityType: "result"` `approval_requests`
 * row per result it moves to `under_review` (`entityId` = that
 * `exam_results` row's own id — a real, per-student decision unit, not the
 * exam). `approveResult`/`rejectResult` each resolve the one `pending`
 * request for their target result and delegate the actual decision —
 * including the self-approval block and the one-shot-decision guard — to
 * `decideApprovalRequest` (Item 50a, read-only here), exactly the pattern
 * lib/academies/grade-configurations.ts's `approveGradeConfig`/
 * `rejectGradeConfig` already established. No self-approval or
 * already-decided logic is reimplemented in this file.
 *
 * ---------------------------------------------------------------------
 * Skipped resting states — `submitted` and `rejected` are never actually
 * persisted as a row's live status by this file
 * ---------------------------------------------------------------------
 * `exam_results.status`'s enum (Item 48's schema, read-only) includes both
 * `submitted` and `rejected` as literal values, yet this file never leaves
 * a row sitting in either:
 *
 *   - `submitResults`: the Lifecycle table's own words say "Submitted ->
 *     Under Review" happens "automatic[ally] on submission (no separate
 *     action)" — there is no window in which a caller could observe a row
 *     at `submitted` distinctly from `under_review`, so `submitResults`
 *     writes `status = "under_review"` directly (plus `submitted_at`,
 *     which does record the real submission moment) rather than writing
 *     `submitted` and immediately overwriting it in the same transaction
 *     for no observable benefit.
 *
 *   - `rejectResult`: the Lifecycle table's "To" column for this row
 *     literally reads "Rejected -> back to Draft" — the resting state the
 *     table itself names is Draft, not Rejected. This matters beyond
 *     nomenclature: lib/academies/exams.ts's `enterMarks` (Item 48,
 *     read-only) only accepts re-entry on a row whose status is `draft` or
 *     `marks_entered` (its own `invalid_state` guard refuses anything
 *     else) — writing `status = "rejected"` here would strand the row
 *     somewhere `enterMarks` can never touch again, breaking the exact
 *     "revise and resubmit" loop the transition table names. So
 *     `rejectResult` writes `status = "draft"` directly. The `rejected`
 *     enum value is left unused by this file (it stays on the column for
 *     any future consumer that might want a momentary/audit-visible
 *     `rejected` state); the durable "this was rejected, and why" fact
 *     lives on the `approval_requests` row itself (`status: "rejected"`,
 *     `reason`), which this file does still write.
 *
 * ---------------------------------------------------------------------
 * `publishResults` — where grade evaluation actually happens
 * ---------------------------------------------------------------------
 * Per Item 48's own documented finding on `exam_results.grade_configuration_id`
 * ("nothing is immutable until Published ... publishResults still must
 * re-stamp grade_configuration_id at actual publish time"): `publishResults`
 * looks up the academy's current `active` grade_configuration (same
 * "active" lookup Item 48's `createExam` uses), evaluates each result's
 * `marks_obtained` against that configuration's `grade_bands` (inclusive on
 * both ends, `min_mark <= marks_obtained <= max_mark` — the same inclusive
 * convention lib/academies/grade-configurations.ts's exclusion-constraint
 * comment documents for band ranges), and only then stamps
 * `grade_configuration_id`/`grade_band_label`/`pass_fail`/`status`/
 * `published_at` — all in one transaction per call, so a validation
 * failure on any targeted result (no active config, no matching band, a
 * null `marks_obtained`) aborts the whole call rather than publishing a
 * partial, inconsistent batch.
 *
 * ---------------------------------------------------------------------
 * Immutability — enforced by state guards, not a special-cased check
 * ---------------------------------------------------------------------
 * PLAN.md: "Immutable fields once Published: marks_obtained,
 * grade_configuration_id, grade_band_label, pass_fail — changeable only
 * via an approved correction [Item 50b]." No function in this file writes
 * any of those four columns except `publishResults` itself, and
 * `publishResults` only ever proceeds when the target row's status is
 * `"approved"` (never `"published"`) — so a second `publishResults` call,
 * or any `approveResult`/`rejectResult` call, against an already-`published`
 * row is refused with `invalid_state` before touching a single column.
 * This is exactly what this file's immutability test exercises: every
 * exported mutator in this file, called against a directly-inserted
 * `published` row, must refuse and leave the row's four immutable columns
 * untouched.
 */

function canSubmitLevel(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage" || level === "enter_marks";
}

function canApproveLevel(level: AcademyPermissionLevel): boolean {
  return level === "approve";
}

export interface ResultActionError {
  code:
    | "forbidden"
    | "validation"
    | "not_found"
    | "blocked"
    | "conflict"
    | "invalid_state"
    // Same as lib/academies/grade-configurations.ts's GradeConfigActionError:
    // decideApprovalRequest's (Item 50a) two guard failures, surfaced
    // as-is rather than collapsed into "forbidden".
    | "self_approval"
    | "already_decided";
  message: string;
}

const FORBIDDEN: ResultActionError = {
  code: "forbidden",
  message: "You don't have permission to manage this academy's results.",
};

// Same generic-message IDOR-safety convention as lib/academies/exams.ts:
// nonexistent, cross-academy, and out-of-scope-for-a-trainer all
// indistinguishable, including for a guessed id.
const EXAM_NOT_FOUND: ResultActionError = {
  code: "not_found",
  message: "Exam not found.",
};

const RESULT_NOT_FOUND: ResultActionError = {
  code: "not_found",
  message: "Result not found.",
};

const NO_ACTIVE_GRADE_CONFIG: ResultActionError = {
  code: "validation",
  message:
    "This academy has no active grade configuration yet. Activate one before publishing results.",
};

interface ResolvedResultAccess {
  academyId: string;
  membershipRole: AcademyRole;
}

type ResolveResultAccessResult =
  | { ok: true; access: ResolvedResultAccess }
  | { ok: false; error: ResultActionError };

async function resolveResultAccess(actorContext: AuthContext): Promise<ResolveResultAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  return {
    ok: true,
    access: { academyId: access.academyId, membershipRole: access.membershipRole },
  };
}

/** Maps `decideApprovalRequest`'s (Item 50a) error codes onto this file's
 * own `ResultActionError` shape without collapsing them — same pattern as
 * lib/academies/grade-configurations.ts's `mapDecisionError`. */
function mapDecisionError(error: { code: string; message: string }): ResultActionError {
  if (error.code === "self_approval" || error.code === "already_decided") {
    return { code: error.code, message: error.message };
  }
  return { code: "validation", message: error.message };
}

export interface ResultRecord {
  id: string;
  academyId: string;
  examId: string;
  studentId: string;
  batchId: string;
  marksObtained: number | null;
  gradeConfigurationId: string;
  gradeBandLabel: string | null;
  passFail: "pending" | "pass" | "fail";
  status: "draft" | "marks_entered" | "submitted" | "under_review" | "approved" | "rejected" | "published";
  enteredBy: string;
  submittedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toResultRecord(row: typeof examResults.$inferSelect): ResultRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    examId: row.examId,
    studentId: row.studentId,
    batchId: row.batchId,
    marksObtained: row.marksObtained !== null ? Number(row.marksObtained) : null,
    gradeConfigurationId: row.gradeConfigurationId,
    gradeBandLabel: row.gradeBandLabel,
    passFail: row.passFail,
    status: row.status,
    enteredBy: row.enteredBy,
    submittedAt: row.submittedAt,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface GradeBand {
  label: string;
  minMark: number;
  maxMark: number;
  isPass: boolean;
}

/** Resolves the academy's one `active` grade_configuration and its bands —
 * the hard precondition `publishResults` needs (same "active" lookup Item
 * 48's `createExam` uses for the same purpose, re-implemented here since
 * exams.ts's own helper is private and that file is read-only). */
async function getActiveGradeConfigurationWithBands(
  executor: DbClient,
  academyId: string,
): Promise<{ id: string; bands: GradeBand[] } | null> {
  const [config] = await executor
    .select({ id: gradeConfigurations.id })
    .from(gradeConfigurations)
    .where(and(eq(gradeConfigurations.academyId, academyId), eq(gradeConfigurations.status, "active")))
    .limit(1);
  if (!config) return null;

  const bandRows = await executor
    .select()
    .from(gradeBands)
    .where(eq(gradeBands.gradeConfigurationId, config.id));

  return {
    id: config.id,
    bands: bandRows.map((row) => ({
      label: row.label,
      minMark: Number(row.minMark),
      maxMark: Number(row.maxMark),
      isPass: row.isPass,
    })),
  };
}

/**
 * Inclusive-on-both-ends band lookup (`min_mark <= marksObtained <=
 * max_mark`) — the same bound convention
 * lib/academies/grade-configurations.ts documents for the DB exclusion
 * constraint's `numrange(...)` bound spec. Returns `null` if no band
 * covers the given marks (shouldn't happen if grade_bands cover the full
 * range, but `publishResults` treats this as a hard refusal, never a
 * silent default).
 */
export function evaluateGradeBand(marksObtained: number, bands: GradeBand[]): GradeBand | null {
  for (const band of bands) {
    if (marksObtained >= band.minMark && marksObtained <= band.maxMark) {
      return band;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// submitResults — Result Lifecycle: "Marks Entered -> Submitted" (and the
// automatic "Submitted -> Under Review" right behind it — see this file's
// module comment on why only "under_review" is ever actually persisted).
// ---------------------------------------------------------------------------

export const submitResultsSchema = z.object({
  // Optional: submit only this subset of the exam's marks_entered results.
  // Omitted (or undefined) submits every currently marks_entered result for
  // the exam — the same "partial or full" shape enterMarks (Item 48) uses.
  studentIds: z.array(z.string().uuid()).optional(),
});

export type SubmitResultsInput = z.input<typeof submitResultsSchema>;

export type SubmitResultsResult =
  | { ok: true; results: ResultRecord[] }
  | { ok: false; error: ResultActionError };

export async function submitResults(
  actorContext: AuthContext,
  examId: string,
  input: SubmitResultsInput = {},
): Promise<SubmitResultsResult> {
  const resolved = await resolveResultAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const level = getAcademyPermissionLevel(membershipRole, ACADEMY_EXAMS_ACTION);
  if (!canSubmitLevel(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedExamId = z.string().uuid().safeParse(examId);
  if (!parsedExamId.success) return { ok: false, error: EXAM_NOT_FOUND };

  const parsed = submitResultsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const { studentIds } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [exam] = await tx
      .select()
      .from(exams)
      .where(and(eq(exams.id, examId), eq(exams.academyId, academyId)))
      .for("update");
    if (!exam) return { outcome: "exam_not_found" as const };

    // Trainer-batch scoping — same mechanism as enterMarks (Item 48), NOT
    // staff_branch_assignments. See this file's module comment.
    if (membershipRole === "trainer") {
      const assignedBatchIds = await getAssignedBatchIds(tx, actorContext.userId, academyId);
      if (!assignedBatchIds.includes(exam.batchId)) {
        return { outcome: "exam_not_found" as const };
      }
    }

    // audit_logs.branch_id is a real FK to branches.id, not batches.id —
    // exam.batchId is a *batch* id, so the actual branch has to be looked
    // up via the batch (same lookup exams.ts's createExam does for its own
    // audit row).
    const [batch] = await tx
      .select({ branchId: batches.branchId })
      .from(batches)
      .where(eq(batches.id, exam.batchId))
      .limit(1);

    const conditions = studentIds
      ? and(eq(examResults.examId, examId), inArray(examResults.studentId, studentIds))
      : eq(examResults.examId, examId);

    const rows = await tx.select().from(examResults).where(conditions).for("update");

    if (studentIds && rows.length !== studentIds.length) {
      return { outcome: "student_not_found" as const };
    }

    const targets = studentIds ? rows : rows.filter((row) => row.status === "marks_entered");

    if (targets.length === 0) {
      return { outcome: "nothing_to_submit" as const };
    }

    for (const row of targets) {
      if (row.status !== "marks_entered") {
        return { outcome: "invalid_state" as const, studentId: row.studentId, status: row.status };
      }
    }

    const before: ResultRecord[] = targets.map(toResultRecord);
    const after: ResultRecord[] = [];
    const now = new Date();

    for (const row of targets) {
      const [updated] = await tx
        .update(examResults)
        .set({ status: "under_review", submittedAt: now, updatedAt: now })
        .where(eq(examResults.id, row.id))
        .returning();
      after.push(toResultRecord(updated));

      const requestResult = await createApprovalRequest(tx, {
        academyId,
        entityType: "result",
        entityId: row.id,
        requestedBy: actorContext.userId,
      });
      if (!requestResult.ok) {
        // Same "unreachable in practice" reasoning as
        // grade-configurations.ts's submitGradeConfigForApproval: the
        // payload here is built entirely from trusted, already-verified
        // values. Thrown (and rolled back) rather than left half-applied.
        throw new Error(`createApprovalRequest failed unexpectedly: ${requestResult.error.message}`);
      }
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "submitResults",
        entityType: "exam",
        entityId: examId,
        branchId: batch?.branchId,
        before,
        after,
      },
      tx,
    );

    return { outcome: "ok" as const, results: after };
  });

  if (result.outcome === "exam_not_found") return { ok: false, error: EXAM_NOT_FOUND };
  if (result.outcome === "student_not_found") {
    return {
      ok: false,
      error: { code: "not_found", message: "One or more studentIds have no result on this exam." },
    };
  }
  if (result.outcome === "nothing_to_submit") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "There are no marks_entered results to submit." },
    };
  }
  if (result.outcome === "invalid_state") {
    return {
      ok: false,
      error: {
        code: "invalid_state",
        message: `Result for student ${result.studentId} cannot be submitted — it is ${result.status}, not marks_entered.`,
      },
    };
  }
  return { ok: true, results: result.results };
}

// ---------------------------------------------------------------------------
// approveResult / rejectResult — Result Lifecycle: "Under Review ->
// Approved" / "Under Review -> Rejected -> back to Draft".
// ---------------------------------------------------------------------------

/** Shared by `approveResult`/`rejectResult`: the one `pending`
 * `approval_requests` row for this result, if any — same defensive
 * "invalid_state, not not_found" treatment as
 * grade-configurations.ts's `findPendingApprovalRequest` for a missing row
 * (this module's own public API never produces that state, but it's
 * handled rather than assumed impossible). */
async function findPendingApprovalRequest(tx: DbClient, resultId: string) {
  const [pending] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.entityType, "result"),
        eq(approvalRequests.entityId, resultId),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);
  return pending ?? null;
}

export type ApproveResultResult =
  | { ok: true; result: ResultRecord }
  | { ok: false; error: ResultActionError };

export async function approveResult(
  actorContext: AuthContext,
  resultId: string,
): Promise<ApproveResultResult> {
  const resolved = await resolveResultAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const level = getAcademyPermissionLevel(membershipRole, ACADEMY_RESULTS_ACTION);
  if (!canApproveLevel(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(resultId);
  if (!parsedId.success) return { ok: false, error: RESULT_NOT_FOUND };

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(examResults)
      .where(and(eq(examResults.id, resultId), eq(examResults.academyId, academyId)))
      .for("update");
    if (!row) return { kind: "not_found" as const };
    if (row.status !== "under_review") return { kind: "invalid_state" as const };

    const pending = await findPendingApprovalRequest(tx, resultId);
    if (!pending) return { kind: "invalid_state" as const };

    const decision = await decideApprovalRequest(tx, pending.id, {
      decidedBy: actorContext.userId,
      status: "approved",
    });
    if (!decision.ok) return { kind: "decision_error" as const, error: decision.error };

    const now = new Date();
    const [updated] = await tx
      .update(examResults)
      .set({ status: "approved", approvedBy: actorContext.userId, approvedAt: now, updatedAt: now })
      .where(eq(examResults.id, resultId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "approveResult",
        entityType: "result",
        entityId: resultId,
        before: toResultRecord(row),
        after: toResultRecord(updated),
      },
      tx,
    );

    return { kind: "ok" as const, result: updated };
  });

  if (result.kind === "not_found") return { ok: false, error: RESULT_NOT_FOUND };
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "Only a result under review can be approved." },
    };
  }
  if (result.kind === "decision_error") return { ok: false, error: mapDecisionError(result.error) };
  return { ok: true, result: toResultRecord(result.result) };
}

export const rejectResultReasonSchema = z
  .string()
  .trim()
  .min(1, "A rejection reason is required.")
  .max(2000);

export type RejectResultResult =
  | { ok: true; result: ResultRecord }
  | { ok: false; error: ResultActionError };

/**
 * `status` ends at `"draft"`, not the enum's `"rejected"` value — see this
 * file's module comment ("Skipped resting states") for why. `submitted_at`
 * is cleared (the row is no longer in a submitted state); `marks_obtained`
 * is left untouched so the reviewer's original entry is still visible to
 * whoever revises it via `enterMarks`.
 */
export async function rejectResult(
  actorContext: AuthContext,
  resultId: string,
  reason: string,
): Promise<RejectResultResult> {
  const resolved = await resolveResultAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const level = getAcademyPermissionLevel(membershipRole, ACADEMY_RESULTS_ACTION);
  if (!canApproveLevel(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(resultId);
  if (!parsedId.success) return { ok: false, error: RESULT_NOT_FOUND };

  const parsedReason = rejectResultReasonSchema.safeParse(reason);
  if (!parsedReason.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsedReason.error.issues[0]?.message ?? "A rejection reason is required.",
      },
    };
  }

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(examResults)
      .where(and(eq(examResults.id, resultId), eq(examResults.academyId, academyId)))
      .for("update");
    if (!row) return { kind: "not_found" as const };
    if (row.status !== "under_review") return { kind: "invalid_state" as const };

    const pending = await findPendingApprovalRequest(tx, resultId);
    if (!pending) return { kind: "invalid_state" as const };

    const decision = await decideApprovalRequest(tx, pending.id, {
      decidedBy: actorContext.userId,
      status: "rejected",
    });
    if (!decision.ok) return { kind: "decision_error" as const, error: decision.error };

    await tx
      .update(approvalRequests)
      .set({ reason: parsedReason.data })
      .where(eq(approvalRequests.id, pending.id));

    const now = new Date();
    const [updated] = await tx
      .update(examResults)
      .set({ status: "draft", submittedAt: null, updatedAt: now })
      .where(eq(examResults.id, resultId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "rejectResult",
        entityType: "result",
        entityId: resultId,
        before: toResultRecord(row),
        after: { ...toResultRecord(updated), reason: parsedReason.data },
        reason: parsedReason.data,
      },
      tx,
    );

    return { kind: "ok" as const, result: updated };
  });

  if (result.kind === "not_found") return { ok: false, error: RESULT_NOT_FOUND };
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "Only a result under review can be rejected." },
    };
  }
  if (result.kind === "decision_error") return { ok: false, error: mapDecisionError(result.error) };
  return { ok: true, result: toResultRecord(result.result) };
}

// ---------------------------------------------------------------------------
// publishResults — Result Lifecycle: "Approved -> Published". Grade
// evaluation happens here (see this file's module comment).
// ---------------------------------------------------------------------------

export const publishResultsSchema = z.object({
  // Optional: publish only this subset of the exam's approved results.
  // Omitted publishes every currently approved result for the exam.
  studentIds: z.array(z.string().uuid()).optional(),
});

export type PublishResultsInput = z.input<typeof publishResultsSchema>;

export type PublishResultsResult =
  | { ok: true; results: ResultRecord[] }
  | { ok: false; error: ResultActionError };

export async function publishResults(
  actorContext: AuthContext,
  examId: string,
  input: PublishResultsInput = {},
): Promise<PublishResultsResult> {
  const resolved = await resolveResultAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const level = getAcademyPermissionLevel(membershipRole, ACADEMY_RESULTS_ACTION);
  if (!canApproveLevel(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedExamId = z.string().uuid().safeParse(examId);
  if (!parsedExamId.success) return { ok: false, error: EXAM_NOT_FOUND };

  const parsed = publishResultsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const { studentIds } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [exam] = await tx
      .select({ id: exams.id, batchId: exams.batchId })
      .from(exams)
      .where(and(eq(exams.id, examId), eq(exams.academyId, academyId)))
      .for("update");
    if (!exam) return { outcome: "exam_not_found" as const };

    // audit_logs.branch_id is a real FK to branches.id, not batches.id —
    // see submitResults' identical lookup/comment above.
    const [batch] = await tx
      .select({ branchId: batches.branchId })
      .from(batches)
      .where(eq(batches.id, exam.batchId))
      .limit(1);

    const activeConfig = await getActiveGradeConfigurationWithBands(tx, academyId);
    if (!activeConfig) return { outcome: "no_active_grade_config" as const };

    const conditions = studentIds
      ? and(eq(examResults.examId, examId), inArray(examResults.studentId, studentIds))
      : eq(examResults.examId, examId);

    const rows = await tx.select().from(examResults).where(conditions).for("update");

    if (studentIds && rows.length !== studentIds.length) {
      return { outcome: "student_not_found" as const };
    }

    const targets = studentIds ? rows : rows.filter((row) => row.status === "approved");

    if (targets.length === 0) {
      return { outcome: "nothing_to_publish" as const };
    }

    const evaluations: { row: (typeof rows)[number]; band: GradeBand }[] = [];
    for (const row of targets) {
      if (row.status !== "approved") {
        return { outcome: "invalid_state" as const, studentId: row.studentId, status: row.status };
      }
      if (row.marksObtained === null) {
        return { outcome: "missing_marks" as const, studentId: row.studentId };
      }
      const band = evaluateGradeBand(Number(row.marksObtained), activeConfig.bands);
      if (!band) {
        return { outcome: "no_matching_band" as const, studentId: row.studentId };
      }
      evaluations.push({ row, band });
    }

    const before: ResultRecord[] = evaluations.map((entry) => toResultRecord(entry.row));
    const after: ResultRecord[] = [];
    const now = new Date();

    for (const { row, band } of evaluations) {
      const [updated] = await tx
        .update(examResults)
        .set({
          gradeConfigurationId: activeConfig.id,
          gradeBandLabel: band.label,
          passFail: band.isPass ? "pass" : "fail",
          status: "published",
          publishedAt: now,
          updatedAt: now,
        })
        .where(eq(examResults.id, row.id))
        .returning();
      after.push(toResultRecord(updated));
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "publishResults",
        entityType: "exam",
        entityId: examId,
        branchId: batch?.branchId,
        before,
        after,
      },
      tx,
    );

    return { outcome: "ok" as const, results: after };
  });

  if (result.outcome === "exam_not_found") return { ok: false, error: EXAM_NOT_FOUND };
  if (result.outcome === "no_active_grade_config") return { ok: false, error: NO_ACTIVE_GRADE_CONFIG };
  if (result.outcome === "student_not_found") {
    return {
      ok: false,
      error: { code: "not_found", message: "One or more studentIds have no result on this exam." },
    };
  }
  if (result.outcome === "nothing_to_publish") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "There are no approved results to publish." },
    };
  }
  if (result.outcome === "invalid_state") {
    return {
      ok: false,
      error: {
        code: "invalid_state",
        message: `Result for student ${result.studentId} cannot be published — it is ${result.status}, not approved.`,
      },
    };
  }
  if (result.outcome === "missing_marks") {
    return {
      ok: false,
      error: {
        code: "validation",
        message: `Result for student ${result.studentId} has no marks_obtained recorded — cannot publish.`,
      },
    };
  }
  if (result.outcome === "no_matching_band") {
    return {
      ok: false,
      error: {
        code: "validation",
        message: `Result for student ${result.studentId}'s marks don't fall into any grade band of the active configuration.`,
      },
    };
  }
  return { ok: true, results: result.results };
}

// ---------------------------------------------------------------------------
// Read helpers.
// ---------------------------------------------------------------------------

export interface ResultRosterRow extends ResultRecord {
  studentFullName: string;
  studentNumber: string;
}

export type ListResultsResult =
  | { ok: true; results: ResultRosterRow[]; canSubmit: boolean; canApprove: boolean }
  | { ok: false; error: ResultActionError };

/** Lists exam_results for the academy, optionally filtered to one exam. A
 * Trainer only ever sees results on batches they're assigned to teach
 * (`getAssignedBatchIds`) — same scoping `submitResults`/`enterMarks`
 * enforce, applied defensively here so `/academy/results` never even lists
 * an out-of-scope result for a Trainer. */
export async function listResults(
  actorContext: AuthContext,
  examId?: string,
): Promise<ListResultsResult> {
  const resolved = await resolveResultAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const submitLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_EXAMS_ACTION);
  const approveLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_RESULTS_ACTION);
  if (!canSubmitLevel(submitLevel) && !canApproveLevel(approveLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  let allowedBatchIds: string[] | null = null;
  if (membershipRole === "trainer") {
    allowedBatchIds = await getAssignedBatchIds(db, actorContext.userId, academyId);
  }

  if (examId !== undefined) {
    const parsedId = z.string().uuid().safeParse(examId);
    if (!parsedId.success) return { ok: false, error: EXAM_NOT_FOUND };
    const [exam] = await db
      .select({ id: exams.id, batchId: exams.batchId })
      .from(exams)
      .where(and(eq(exams.id, examId), eq(exams.academyId, academyId)))
      .limit(1);
    if (!exam) return { ok: false, error: EXAM_NOT_FOUND };
    if (allowedBatchIds && !allowedBatchIds.includes(exam.batchId)) {
      return { ok: false, error: EXAM_NOT_FOUND };
    }
  }

  const conditions = examId !== undefined
    ? and(eq(examResults.academyId, academyId), eq(examResults.examId, examId))
    : eq(examResults.academyId, academyId);

  const rows = await db
    .select({
      result: examResults,
      studentFullName: students.fullName,
      studentNumber: students.studentNumber,
    })
    .from(examResults)
    .innerJoin(students, eq(students.id, examResults.studentId))
    .where(conditions);

  const visible = allowedBatchIds
    ? rows.filter((row) => allowedBatchIds!.includes(row.result.batchId))
    : rows;

  return {
    ok: true,
    results: visible.map((row) => ({
      ...toResultRecord(row.result),
      studentFullName: row.studentFullName,
      studentNumber: row.studentNumber,
    })),
    canSubmit: canSubmitLevel(submitLevel),
    canApprove: canApproveLevel(approveLevel),
  };
}

export type GetResultResult =
  | {
      ok: true;
      result: ResultRecord;
      canSubmit: boolean;
      canApprove: boolean;
      /** Whether the current actor is the one who most recently submitted
       * this result for review — the requester side of `approval_requests`'
       * self-approval guard, surfaced here so a UI can disable its own
       * Approve/Reject controls before even attempting the call. `null`
       * when the result has never been submitted. */
      isOwnSubmission: boolean | null;
    }
  | { ok: false; error: ResultActionError };

/** Tenant- and (for a Trainer) batch-scoped single read. IDOR-safe:
 * nonexistent, cross-academy, and out-of-scope-for-a-trainer ids all
 * return the identical generic `RESULT_NOT_FOUND`. */
export async function getResult(actorContext: AuthContext, resultId: string): Promise<GetResultResult> {
  const resolved = await resolveResultAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const submitLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_EXAMS_ACTION);
  const approveLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_RESULTS_ACTION);
  if (!canSubmitLevel(submitLevel) && !canApproveLevel(approveLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(resultId);
  if (!parsedId.success) return { ok: false, error: RESULT_NOT_FOUND };

  const [row] = await db
    .select()
    .from(examResults)
    .where(and(eq(examResults.id, resultId), eq(examResults.academyId, academyId)))
    .limit(1);
  if (!row) return { ok: false, error: RESULT_NOT_FOUND };

  if (membershipRole === "trainer") {
    const assignedBatchIds = await getAssignedBatchIds(db, actorContext.userId, academyId);
    if (!assignedBatchIds.includes(row.batchId)) return { ok: false, error: RESULT_NOT_FOUND };
  }

  const [latestRequest] = await db
    .select({ requestedBy: approvalRequests.requestedBy })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.entityType, "result"), eq(approvalRequests.entityId, resultId)))
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1);

  return {
    ok: true,
    result: toResultRecord(row),
    canSubmit: canSubmitLevel(submitLevel),
    canApprove: canApproveLevel(approveLevel),
    isOwnSubmission: latestRequest ? latestRequest.requestedBy === actorContext.userId : null,
  };
}
