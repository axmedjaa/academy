import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  approvalRequests,
  examResults,
  gradeBands,
  gradeConfigurations,
  resultCorrections,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { createApprovalRequest, decideApprovalRequest } from "@/lib/academies/approval-requests";
import {
  ACADEMY_RESULTS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { evaluateGradeBand, type ResultRecord } from "@/lib/academies/results";

/**
 * PLAN.md Phase 3, Item 50b — "`result_corrections` + `requestResultCorrection`
 * flow."
 *
 * ---------------------------------------------------------------------
 * Scope: what this item builds vs. what it deliberately does not
 * ---------------------------------------------------------------------
 * The Result Lifecycle table's last two rows: "Published -> Correction
 * Requested" (`requestResultCorrection`) and "Correction Requested ->
 * Corrected -> Reapproved -> Republished" / "Correction Requested -> back
 * to Published (unchanged)" (routed through the same approve/reject
 * queue — see below). Item 49 (lib/academies/results.ts, read-only here)
 * already built `submitResults`/`approveResult`/`rejectResult`/
 * `publishResults` for the first five rows of that table.
 *
 * ---------------------------------------------------------------------
 * "Correction Requested" is a conceptual UI state, not a new
 * exam_results.status value — see lib/db/schema.ts's comment on
 * `resultCorrections` for the schema-level reasoning. The underlying
 * `exam_results` row stays `status = "published"` for the whole
 * request -> decide -> apply cycle; this file's own `result_corrections`
 * table (`status`: requested/approved/rejected/applied) is what actually
 * tracks where a given correction is.
 *
 * ---------------------------------------------------------------------
 * Permission gating — reused, not new
 * ---------------------------------------------------------------------
 * Master Permission Matrix row 131, "Result correction request": "Same
 * authority as submit/approve above — no separate role." `requestResultCorrection`
 * is Manager/Admin/Owner per the Result Lifecycle table's own actor column
 * for this row — exactly the same three roles Item 49's
 * `ACADEMY_RESULTS_ACTION` "approve" level already grants (see that row's
 * own comment in lib/auth/academy-permissions.ts). Deciding a correction
 * (`decideResultCorrection`) is the same "Manager/Admin/Owner, never the
 * requester" authority as `approveResult`/`rejectResult`. Both gate on
 * `ACADEMY_RESULTS_ACTION`'s `"approve"` level — no new permission row or
 * level is added for this item, and lib/auth/academy-permissions.ts is not
 * touched by this file at all.
 *
 * ---------------------------------------------------------------------
 * Judgment call, flagged: how "routes through the same approveResult/
 * rejectResult queue" actually integrates with `approval_requests`
 * ---------------------------------------------------------------------
 * `approval_requests.entity_type` (Item 50a's schema, read-only) is a
 * fixed enum: `result` / `grade_configuration` / `expense` /
 * `student_payment` — there is no `result_correction` value, and PLAN.md
 * never adds one. The most sensible reading of "routes through the same
 * approveResult/rejectResult queue" given that hard constraint:
 * `requestResultCorrection` creates a `result_corrections` row (status
 * `requested`) AND calls `createApprovalRequest` with `entityType:
 * "result"`, `entityId: originalResultId` — reusing the SAME entity_type a
 * normal (pre-publish) result submission already uses, since a correction
 * is conceptually still "a pending decision about this result," not a
 * different kind of entity. This is a deliberate interpretation of an
 * underspecified integration point, not a literal PLAN.md instruction —
 * documented here rather than silently assumed.
 *
 * One consequence of reusing `entity_type: "result"`/`entity_id:
 * originalResultId`: Item 49's `findPendingApprovalRequest`-style lookup
 * (by entityType + entityId + status="pending") is exactly what this
 * file's own `findPendingCorrectionApprovalRequest` below does too — the
 * two features never collide in practice because a result can only ever
 * have a `pending` approval_requests row while it's either under_review
 * (Item 49's flow, pre-publish) or has an open correction request (this
 * file's flow, post-publish) — never both at once, since
 * `requestResultCorrection` itself is only callable on a `published`
 * result (which by definition already cleared Item 49's under_review ->
 * approved -> published path and closed that request).
 *
 * `decideResultCorrection` (split into `approveResultCorrection`/
 * `rejectResultCorrection` below, mirroring `approveResult`/`rejectResult`'s
 * own split rather than one function with a status parameter, for the same
 * "one exported action per PLAN.md-named transition" convention this
 * codebase already follows everywhere else) calls the SAME
 * `decideApprovalRequest` (Item 50a) `approveResult`/`rejectResult`
 * delegate to — so the self-approval guard ("the requester cannot decide
 * their own correction request") and the one-shot-decision guard are
 * reused, not reimplemented, exactly as instructed.
 *
 * ---------------------------------------------------------------------
 * Approval and application happen atomically — "the instant it's
 * approved"
 * ---------------------------------------------------------------------
 * `approveResultCorrection` performs the `decideApprovalRequest` call,
 * the `exam_results` update (marks_obtained, re-evaluated pass_fail/
 * grade_band_label), the `applied_at` stamp, and the `result_corrections`
 * row's flip to `applied` all inside one `db.transaction` — there is no
 * separate "publish" step and no window where the correction is approved
 * but not yet reflected on the row, matching PLAN.md's "the corrected
 * value takes effect on the same row the instant it's approved" wording
 * literally.
 *
 * ---------------------------------------------------------------------
 * Judgment call, flagged: re-evaluate against which grade configuration —
 * the result's own snapshot, or whatever is active now?
 * ---------------------------------------------------------------------
 * PLAN.md's own wording for this edge case: "re-run the SAME grade-
 * evaluation logic publishResults used (re-derive pass_fail/grade_band_label
 * against the current active grade config, or the result's already-
 * snapshotted config — read PLAN.md's exact wording again for which one it
 * should be)." The literal PLAN.md text (Lifecycle & State-Transition
 * Tables' "Immutable fields once Published" note) says the four fields
 * are "changeable only via an approved correction, which updates them in
 * place" — it does not say the correction re-resolves which grade
 * configuration applies. Resolution adopted here: re-evaluate against the
 * result's own ALREADY-SNAPSHOTTED `grade_configuration_id` (the one
 * `publishResults` stamped at publish time), NOT whatever configuration
 * happens to be `active` now. Reasoning:
 *   1. `grade_configuration_id` is documented everywhere else in this
 *      codebase (schema.ts's comment on `examResults`, exams.ts's module
 *      comment, results.ts's module comment) as "snapshotted at publish
 *      time, never updated after [publish]" — a correction is explicitly
 *      the ONE exception to "never updated after," but only for the four
 *      named immutable fields (`marks_obtained`, `grade_configuration_id`,
 *      `grade_band_label`, `pass_fail`) as a *value change*, not as license
 *      to re-run publish-time policy resolution against a config that may
 *      have changed for unrelated reasons since this exam was published.
 *   2. A correction's whole point is fixing a data-entry mistake in
 *      `marks_obtained` (e.g. transcription error) — the grading POLICY
 *      that was in force when this exam's cohort was graded should still
 *      be the one applied to the corrected mark, exactly as it was applied
 *      to every other student's result in the same exam/batch. Silently
 *      switching a single corrected student's grading policy to whatever
 *      is active *today* — possibly months later, under a wholly different
 *      grade-band configuration — would make that one student's grade
 *      inconsistent with their own cohort's for no reason connected to the
 *      correction itself.
 *   3. This also keeps `grade_configuration_id` truly unaffected by the
 *      correction unless a future item explicitly asks for it to move —
 *      the correction here only ever rewrites `grade_band_label`/
 *      `pass_fail` (re-derived) and `marks_obtained` (the actual fix),
 *      never `grade_configuration_id` itself, since it doesn't need to
 *      move under this reading.
 * If the academy's currently-active configuration has since been retired
 * (its bands deleted, say) this reading also avoids a correction failing
 * for a reason unrelated to the correction being requested. Flagged as a
 * genuine interpretation, not a literal instruction.
 */

function canRequestOrDecide(level: AcademyPermissionLevel): boolean {
  return level === "approve";
}

export interface ResultCorrectionActionError {
  code:
    | "forbidden"
    | "validation"
    | "not_found"
    | "blocked"
    | "conflict"
    | "invalid_state"
    | "self_approval"
    | "already_decided";
  message: string;
}

const FORBIDDEN: ResultCorrectionActionError = {
  code: "forbidden",
  message: "You don't have permission to manage result corrections for this academy.",
};

const RESULT_NOT_FOUND: ResultCorrectionActionError = {
  code: "not_found",
  message: "Result not found.",
};

const CORRECTION_NOT_FOUND: ResultCorrectionActionError = {
  code: "not_found",
  message: "Result correction request not found.",
};

interface ResolvedAccess {
  academyId: string;
  membershipRole: AcademyRole;
}

type ResolveAccessResult = { ok: true; access: ResolvedAccess } | { ok: false; error: ResultCorrectionActionError };

async function resolveAccess(actorContext: AuthContext): Promise<ResolveAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  return {
    ok: true,
    access: { academyId: access.academyId, membershipRole: access.membershipRole },
  };
}

function mapDecisionError(error: { code: string; message: string }): ResultCorrectionActionError {
  if (error.code === "self_approval" || error.code === "already_decided") {
    return { code: error.code, message: error.message };
  }
  return { code: "validation", message: error.message };
}

export interface ResultCorrectionRecord {
  id: string;
  academyId: string;
  originalResultId: string;
  requestedBy: string;
  reason: string;
  proposedMarksObtained: number | null;
  status: "requested" | "approved" | "rejected" | "applied";
  decidedBy: string | null;
  decidedAt: Date | null;
  appliedAt: Date | null;
  createdAt: Date;
}

function toCorrectionRecord(row: typeof resultCorrections.$inferSelect): ResultCorrectionRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    originalResultId: row.originalResultId,
    requestedBy: row.requestedBy,
    reason: row.reason,
    proposedMarksObtained: row.proposedMarksObtained !== null ? Number(row.proposedMarksObtained) : null,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    appliedAt: row.appliedAt,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// requestResultCorrection — Result Lifecycle: "Published -> Correction
// Requested".
// ---------------------------------------------------------------------------

export const requestResultCorrectionSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required.").max(2000),
  // Nullable/omittable: PLAN.md's column list marks proposed_marks_obtained
  // nullable — a correction request might, in principle, be about
  // something other than the mark itself (though marks_obtained is the
  // only field this file's own apply step ever rewrites — see this file's
  // module comment). Validated the same way exam_results.marks_obtained
  // is validated in lib/academies/exams.ts's enterMarks (nonnegative).
  proposedMarksObtained: z
    .union([z.number(), z.string()])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value >= 0, {
      message: "proposedMarksObtained must be a nonnegative number",
    })
    .optional()
    .nullable(),
});

export type RequestResultCorrectionInput = z.input<typeof requestResultCorrectionSchema>;

export type RequestResultCorrectionResult =
  | { ok: true; correction: ResultCorrectionRecord }
  | { ok: false; error: ResultCorrectionActionError };

export async function requestResultCorrection(
  actorContext: AuthContext,
  originalResultId: string,
  input: RequestResultCorrectionInput,
): Promise<RequestResultCorrectionResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const level = getAcademyPermissionLevel(membershipRole, ACADEMY_RESULTS_ACTION);
  if (!canRequestOrDecide(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(originalResultId);
  if (!parsedId.success) return { ok: false, error: RESULT_NOT_FOUND };

  const parsed = requestResultCorrectionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [resultRow] = await tx
      .select()
      .from(examResults)
      .where(and(eq(examResults.id, originalResultId), eq(examResults.academyId, academyId)))
      .for("update");
    if (!resultRow) return { kind: "not_found" as const };

    // requestResultCorrection is only valid on a Published result — see
    // the Result Lifecycle table's own "Published -> Correction Requested"
    // row. A result mid-review (under_review/approved) already has its own
    // live approval_requests row via Item 49's flow; allowing a correction
    // request there would create a second, colliding pending request for
    // the same (entityType: "result", entityId) pair.
    if (resultRow.status !== "published") {
      return { kind: "invalid_state" as const };
    }

    const [correctionRow] = await tx
      .insert(resultCorrections)
      .values({
        academyId,
        originalResultId,
        requestedBy: actorContext.userId,
        reason: data.reason,
        proposedMarksObtained:
          data.proposedMarksObtained !== undefined && data.proposedMarksObtained !== null
            ? String(data.proposedMarksObtained)
            : null,
      })
      .returning();

    // Reuses entityType: "result" — see this file's module comment's
    // "Judgment call, flagged" section for the full reasoning.
    const requestResult = await createApprovalRequest(tx, {
      academyId,
      entityType: "result",
      entityId: originalResultId,
      requestedBy: actorContext.userId,
      reason: data.reason,
    });
    if (!requestResult.ok) {
      // Same "unreachable in practice" reasoning as results.ts's
      // submitResults / grade-configurations.ts's
      // submitGradeConfigForApproval — thrown (and rolled back) rather
      // than left half-applied.
      throw new Error(`createApprovalRequest failed unexpectedly: ${requestResult.error.message}`);
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "requestResultCorrection",
        entityType: "result_correction",
        entityId: correctionRow.id,
        reason: data.reason,
        before: { originalResultId, status: resultRow.status },
        after: toCorrectionRecord(correctionRow),
      },
      tx,
    );

    return { kind: "ok" as const, correction: correctionRow };
  });

  if (result.kind === "not_found") return { ok: false, error: RESULT_NOT_FOUND };
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: {
        code: "invalid_state",
        message: "A correction can only be requested for a published result.",
      },
    };
  }
  return { ok: true, correction: toCorrectionRecord(result.correction) };
}

// ---------------------------------------------------------------------------
// approveResultCorrection / rejectResultCorrection — "Correction Requested
// -> Corrected -> Reapproved -> Republished" (approval IS the apply step)
// / "Correction Requested -> back to Published (unchanged)".
// ---------------------------------------------------------------------------

/** The one `pending` `approval_requests` row for this correction's
 * underlying result — same defensive "invalid_state, not not_found"
 * treatment this codebase's other approval-queue consumers use for a
 * missing row (lib/academies/results.ts's/grade-configurations.ts's own
 * `findPendingApprovalRequest`). */
async function findPendingApprovalRequest(tx: DbClient, originalResultId: string) {
  const [pending] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.entityType, "result"),
        eq(approvalRequests.entityId, originalResultId),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);
  return pending ?? null;
}

export type ApproveResultCorrectionResult =
  | { ok: true; correction: ResultCorrectionRecord; result: ResultRecord }
  | { ok: false; error: ResultCorrectionActionError };

/**
 * Approval IS the republish trigger (PLAN.md: "the corrected value takes
 * effect on the same row the instant it's approved, no separate manual
 * publish click") — this function performs the `decideApprovalRequest`
 * decision, the `exam_results` update, and the `result_corrections` row's
 * flip to `applied` all in one transaction. See this file's module
 * comment for which grade configuration the re-evaluation uses (the
 * result's own already-snapshotted one, not whatever is active today).
 */
export async function approveResultCorrection(
  actorContext: AuthContext,
  correctionId: string,
): Promise<ApproveResultCorrectionResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const level = getAcademyPermissionLevel(membershipRole, ACADEMY_RESULTS_ACTION);
  if (!canRequestOrDecide(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(correctionId);
  if (!parsedId.success) return { ok: false, error: CORRECTION_NOT_FOUND };

  const outcome = await db.transaction(async (tx) => {
    const [correction] = await tx
      .select()
      .from(resultCorrections)
      .where(and(eq(resultCorrections.id, correctionId), eq(resultCorrections.academyId, academyId)))
      .for("update");
    if (!correction) return { kind: "not_found" as const };
    if (correction.status !== "requested") return { kind: "invalid_state" as const };

    const [resultRow] = await tx
      .select()
      .from(examResults)
      .where(eq(examResults.id, correction.originalResultId))
      .for("update");
    if (!resultRow) return { kind: "not_found" as const };
    // Defensive — requestResultCorrection only ever creates a request
    // against a published result, and no other code path in this file or
    // results.ts (read-only) can move a result off `published` while a
    // correction request is pending, but this is not assumed unreachable.
    if (resultRow.status !== "published") return { kind: "invalid_state" as const };

    const pending = await findPendingApprovalRequest(tx, correction.originalResultId);
    if (!pending) return { kind: "invalid_state" as const };

    const decision = await decideApprovalRequest(tx, pending.id, {
      decidedBy: actorContext.userId,
      status: "approved",
    });
    if (!decision.ok) return { kind: "decision_error" as const, error: decision.error };

    // Re-evaluate against the result's OWN already-snapshotted
    // grade_configuration_id, not whatever is active today — see this
    // file's module comment's "Judgment call, flagged" section.
    const [config] = await tx
      .select({ id: gradeConfigurations.id })
      .from(gradeConfigurations)
      .where(eq(gradeConfigurations.id, resultRow.gradeConfigurationId))
      .limit(1);
    if (!config) return { kind: "no_grade_config" as const };

    const bandRows = await tx
      .select()
      .from(gradeBands)
      .where(eq(gradeBands.gradeConfigurationId, config.id));
    const bands = bandRows.map((row) => ({
      label: row.label,
      minMark: Number(row.minMark),
      maxMark: Number(row.maxMark),
      isPass: row.isPass,
    }));

    const newMarks =
      correction.proposedMarksObtained !== null ? Number(correction.proposedMarksObtained) : null;
    if (newMarks === null) return { kind: "no_proposed_marks" as const };

    const band = evaluateGradeBand(newMarks, bands);
    if (!band) return { kind: "no_matching_band" as const };

    const now = new Date();
    const [updatedResult] = await tx
      .update(examResults)
      .set({
        marksObtained: String(newMarks),
        gradeBandLabel: band.label,
        passFail: band.isPass ? "pass" : "fail",
        updatedAt: now,
      })
      .where(eq(examResults.id, correction.originalResultId))
      .returning();

    const [updatedCorrection] = await tx
      .update(resultCorrections)
      .set({ status: "applied", decidedBy: actorContext.userId, decidedAt: now, appliedAt: now })
      .where(eq(resultCorrections.id, correctionId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "approveResultCorrection",
        entityType: "result_correction",
        entityId: correctionId,
        before: {
          marksObtained: resultRow.marksObtained !== null ? Number(resultRow.marksObtained) : null,
          gradeBandLabel: resultRow.gradeBandLabel,
          passFail: resultRow.passFail,
        },
        after: {
          marksObtained: newMarks,
          gradeBandLabel: band.label,
          passFail: band.isPass ? "pass" : "fail",
        },
      },
      tx,
    );

    return { kind: "ok" as const, correction: updatedCorrection, result: updatedResult };
  });

  if (outcome.kind === "not_found") return { ok: false, error: CORRECTION_NOT_FOUND };
  if (outcome.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "Only a requested correction can be approved." },
    };
  }
  if (outcome.kind === "decision_error") return { ok: false, error: mapDecisionError(outcome.error) };
  if (outcome.kind === "no_grade_config") {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "This result's snapshotted grade configuration no longer exists.",
      },
    };
  }
  if (outcome.kind === "no_proposed_marks") {
    return {
      ok: false,
      error: { code: "validation", message: "This correction has no proposedMarksObtained to apply." },
    };
  }
  if (outcome.kind === "no_matching_band") {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "The proposed marks don't fall into any grade band of the result's snapshotted configuration.",
      },
    };
  }

  return {
    ok: true,
    correction: toCorrectionRecord(outcome.correction),
    result: {
      id: outcome.result.id,
      academyId: outcome.result.academyId,
      examId: outcome.result.examId,
      studentId: outcome.result.studentId,
      batchId: outcome.result.batchId,
      marksObtained: outcome.result.marksObtained !== null ? Number(outcome.result.marksObtained) : null,
      gradeConfigurationId: outcome.result.gradeConfigurationId,
      gradeBandLabel: outcome.result.gradeBandLabel,
      passFail: outcome.result.passFail,
      status: outcome.result.status,
      enteredBy: outcome.result.enteredBy,
      submittedAt: outcome.result.submittedAt,
      approvedBy: outcome.result.approvedBy,
      approvedAt: outcome.result.approvedAt,
      publishedAt: outcome.result.publishedAt,
      createdAt: outcome.result.createdAt,
      updatedAt: outcome.result.updatedAt,
    },
  };
}

export const rejectResultCorrectionReasonSchema = z
  .string()
  .trim()
  .min(1, "A rejection reason is required.")
  .max(2000);

export type RejectResultCorrectionResult =
  | { ok: true; correction: ResultCorrectionRecord }
  | { ok: false; error: ResultCorrectionActionError };

/**
 * "Correction Requested -> back to Published (unchanged)" — the
 * exam_results row is untouched (stays published with its original
 * values); only this table's own `status` flips to `rejected`. Reason
 * required (PLAN.md: "yes" on this row), stored the same
 * write-directly-onto-the-approval_requests-row way
 * grade-configurations.ts's `rejectGradeConfig` already does, since
 * `decideApprovalRequest`'s own signature takes no reason parameter.
 */
export async function rejectResultCorrection(
  actorContext: AuthContext,
  correctionId: string,
  reason: string,
): Promise<RejectResultCorrectionResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const level = getAcademyPermissionLevel(membershipRole, ACADEMY_RESULTS_ACTION);
  if (!canRequestOrDecide(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(correctionId);
  if (!parsedId.success) return { ok: false, error: CORRECTION_NOT_FOUND };

  const parsedReason = rejectResultCorrectionReasonSchema.safeParse(reason);
  if (!parsedReason.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsedReason.error.issues[0]?.message ?? "A rejection reason is required.",
      },
    };
  }

  const outcome = await db.transaction(async (tx) => {
    const [correction] = await tx
      .select()
      .from(resultCorrections)
      .where(and(eq(resultCorrections.id, correctionId), eq(resultCorrections.academyId, academyId)))
      .for("update");
    if (!correction) return { kind: "not_found" as const };
    if (correction.status !== "requested") return { kind: "invalid_state" as const };

    const pending = await findPendingApprovalRequest(tx, correction.originalResultId);
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
      .update(resultCorrections)
      .set({ status: "rejected", decidedBy: actorContext.userId, decidedAt: now })
      .where(eq(resultCorrections.id, correctionId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "rejectResultCorrection",
        entityType: "result_correction",
        entityId: correctionId,
        reason: parsedReason.data,
        before: { status: correction.status },
        after: { status: updated.status },
      },
      tx,
    );

    return { kind: "ok" as const, correction: updated };
  });

  if (outcome.kind === "not_found") return { ok: false, error: CORRECTION_NOT_FOUND };
  if (outcome.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "Only a requested correction can be rejected." },
    };
  }
  if (outcome.kind === "decision_error") return { ok: false, error: mapDecisionError(outcome.error) };
  return { ok: true, correction: toCorrectionRecord(outcome.correction) };
}

// ---------------------------------------------------------------------------
// Read helper.
// ---------------------------------------------------------------------------

export type ListResultCorrectionsResult =
  | { ok: true; corrections: ResultCorrectionRecord[]; canManage: boolean }
  | { ok: false; error: ResultCorrectionActionError };

/** Lists result_corrections for the academy, optionally filtered to one
 * original result. Same `ACADEMY_RESULTS_ACTION` "approve" gate as every
 * other action in this file — there is no separate read-only visibility
 * level for this row (Master Permission Matrix's row 131 grants no
 * broader visibility than the request/decide authority itself). */
export async function listResultCorrections(
  actorContext: AuthContext,
  originalResultId?: string,
): Promise<ListResultCorrectionsResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const level = getAcademyPermissionLevel(membershipRole, ACADEMY_RESULTS_ACTION);
  if (!canRequestOrDecide(level)) {
    return { ok: false, error: FORBIDDEN };
  }

  const conditions = originalResultId
    ? and(eq(resultCorrections.academyId, academyId), eq(resultCorrections.originalResultId, originalResultId))
    : eq(resultCorrections.academyId, academyId);

  const rows = await db.select().from(resultCorrections).where(conditions);

  return { ok: true, corrections: rows.map(toCorrectionRecord), canManage: true };
}
