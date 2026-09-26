import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  academyUsage,
  approvalRequests,
  auditLogs,
  batchEnrollments,
  batchTrainerAssignments,
  batches,
  branches,
  certificates,
  courses,
  examResults,
  exams,
  expenseRecords,
  gradeBands,
  gradeConfigurations,
  incomeRecords,
  notificationPreferences,
  notifications,
  programs,
  resultCorrections,
  staffBranchAssignments,
  staffDocuments,
  staffProfiles,
  studentCharges,
  studentDocuments,
  studentIdCards,
  studentPayments,
  students,
  subscriptionPayments,
  timetables,
} from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { deleteObject } from "@/lib/storage/client";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Platform Owner-only permanent academy deletion.
 *
 * ---------------------------------------------------------------------
 * Why this exists as a separate, narrowly-scoped feature — not a general
 * "delete an academy" capability
 * ---------------------------------------------------------------------
 * PLAN.md is explicit and repeated (registration, closure, finance,
 * certificates, the schema itself) that academies are archived, never
 * hard-deleted: "Academy closure: archive model — data retained
 * indefinitely, read-only, never deleted or anonymized" (§ "Academy
 * closure"), "nothing in this plan ever hard-deletes an `academies` ...
 * row that has dependents" (Deletion behavior), and the schema's own
 * comment on `auditLogs.academyId`: "neither FK cascades — academies/
 * branches are never hard-deleted anywhere in this plan, so an audit row
 * can never be orphaned by a delete that isn't supposed to happen in the
 * first place." `closeAcademy` (lib/academies/lifecycle.ts) already gives
 * the platform owner a permanent, irreversible, no-reopen removal from
 * active operation for ANY academy, including one that was never approved
 * — that is the correct action for an academy with real history.
 *
 * This function exists for the narrower, product-approved case: an
 * academy that accumulated NO protected business history at all (created
 * by mistake, a duplicate, a test registration, or closed before it ever
 * did real business) can be removed from the database entirely, so it
 * stops cluttering the platform owner's own view. The eligibility check
 * below is what keeps this from ever contradicting PLAN.md's "never
 * hard-delete" principle: it is refused outright the moment ANY financial,
 * subscription-payment, certificate, or exam-result row exists for the
 * academy — i.e. the only academies this can ever touch are ones that
 * PLAN.md's own protection was never actually protecting anything for.
 *
 * ---------------------------------------------------------------------
 * Audit trail
 * ---------------------------------------------------------------------
 * The academy's audit history (including the "deleteAcademy" row this
 * action itself writes) is never deleted — `auditLogs.academyId` is
 * nullable specifically for this reason (see its schema comment above);
 * every row for this academy has its `academy_id` set to NULL immediately
 * before the academies row itself is removed, so the FK is satisfied and
 * the historical rows (actor, action, before/after snapshots, timestamps)
 * survive forever, just no longer joinable to a live academies row.
 */

const DELETE_CAPABILITY = "deleteAcademy";

export interface AcademyDeletionActionError {
  code: "forbidden" | "validation" | "not_found" | "ineligible";
  message: string;
}

function forbidden(message: string): AcademyDeletionActionError {
  return { code: "forbidden", message };
}

const FORBIDDEN = forbidden("Only the platform owner can permanently delete an academy.");

const academyIdSchema = z.string().uuid("Invalid academy id.");

export interface AcademyDeletionBlockers {
  /** student_charges, student_payments, income_records, or expense_records. */
  hasFinancialHistory: boolean;
  /** subscription_payments — real platform revenue, not tenant finance. */
  hasSubscriptionPayments: boolean;
  hasCertificates: boolean;
  hasExamResults: boolean;
}

export interface AcademyDeletionEligibility {
  academyId: string;
  academyName: string;
  closedAt: Date | null;
  approvedAt: Date | null;
  eligible: boolean;
  blockers: AcademyDeletionBlockers;
}

async function computeDeletionBlockers(
  executor: DbClient,
  academyId: string,
): Promise<AcademyDeletionBlockers> {
  const [[charge], [payment], [income], [expense], [subPayment], [certificate], [examResult]] = await Promise.all([
    executor.select({ id: studentCharges.id }).from(studentCharges).where(eq(studentCharges.academyId, academyId)).limit(1),
    executor.select({ id: studentPayments.id }).from(studentPayments).where(eq(studentPayments.academyId, academyId)).limit(1),
    executor.select({ id: incomeRecords.id }).from(incomeRecords).where(eq(incomeRecords.academyId, academyId)).limit(1),
    executor.select({ id: expenseRecords.id }).from(expenseRecords).where(eq(expenseRecords.academyId, academyId)).limit(1),
    executor.select({ id: subscriptionPayments.id }).from(subscriptionPayments).where(eq(subscriptionPayments.academyId, academyId)).limit(1),
    executor.select({ id: certificates.id }).from(certificates).where(eq(certificates.academyId, academyId)).limit(1),
    executor.select({ id: examResults.id }).from(examResults).where(eq(examResults.academyId, academyId)).limit(1),
  ]);

  return {
    hasFinancialHistory: Boolean(charge || payment || income || expense),
    hasSubscriptionPayments: Boolean(subPayment),
    hasCertificates: Boolean(certificate),
    hasExamResults: Boolean(examResult),
  };
}

function isEligible(blockers: AcademyDeletionBlockers): boolean {
  return !blockers.hasFinancialHistory && !blockers.hasSubscriptionPayments && !blockers.hasCertificates && !blockers.hasExamResults;
}

export type GetAcademyDeletionEligibilityResult =
  | { ok: true; eligibility: AcademyDeletionEligibility }
  | { ok: false; error: AcademyDeletionActionError };

/**
 * Read-only eligibility check, for the platform academy detail page to
 * display before the platform owner ever opens the confirmation dialog.
 * This is a convenience preview only — `deleteAcademy` below re-runs the
 * identical check itself, inside the deletion transaction, as the actual
 * authority (see that function's own comment on why a UI-time check can
 * never be trusted alone).
 */
export async function getAcademyDeletionEligibility(
  actorContext: AuthContext,
  academyId: string,
): Promise<GetAcademyDeletionEligibilityResult> {
  const allowed = await hasPermission(actorContext, DELETE_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = academyIdSchema.safeParse(academyId);
  if (!parsedId.success) {
    return { ok: false, error: { code: "validation", message: parsedId.error.issues[0]?.message ?? "Invalid input." } };
  }

  const [academy] = await db
    .select({ id: academies.id, name: academies.name, closedAt: academies.closedAt, approvedAt: academies.approvedAt })
    .from(academies)
    .where(eq(academies.id, parsedId.data))
    .limit(1);
  if (!academy) {
    return { ok: false, error: { code: "not_found", message: "Academy not found." } };
  }

  const blockers = await computeDeletionBlockers(db, academy.id);

  return {
    ok: true,
    eligibility: {
      academyId: academy.id,
      academyName: academy.name,
      closedAt: academy.closedAt,
      approvedAt: academy.approvedAt,
      eligible: isEligible(blockers),
      blockers,
    },
  };
}

export type DeleteAcademyResult =
  | { ok: true; academyId: string }
  | { ok: false; error: AcademyDeletionActionError };

/**
 * The actual permanent deletion. `confirmedName` must equal the academy's
 * exact current name — this is not just a UI affordance (the type-to-
 * confirm text field), it is re-checked here server-side too, so a stale
 * or manipulated client call can't delete an academy the caller hasn't
 * actually looked at.
 *
 * Eligibility is re-verified from scratch INSIDE this transaction, on a
 * row locked with `for("update")` — the UI's own eligibility preview
 * (`getAcademyDeletionEligibility`, above) is only ever a display hint;
 * something else could record a payment/certificate/result between that
 * read and this call, and this is the check that actually decides whether
 * the delete proceeds. Every disposable table is removed in FK-dependency
 * order (deepest children first — nothing in this schema cascades, see
 * this file's own top comment); every protected table (financial,
 * subscription-payment, certificate, exam-result) is guaranteed empty by
 * the eligibility gate rather than ever being deleted by this code path.
 *
 * R2 logo cleanup: `academies.logoRef` (lib/academies/academy-logo.ts) is
 * captured from the same locked row before the `academies` row itself is
 * deleted, and the corresponding R2 object is removed AFTER this
 * transaction commits — see the cleanup block right after this function's
 * `db.transaction(...)` call for why that has to happen outside the
 * transaction, and why it's best-effort. Eligibility rules, the deletion
 * transaction itself, and the audit trail are all unchanged by this.
 */
export async function deleteAcademy(
  actorContext: AuthContext,
  academyId: string,
  confirmedName: string,
): Promise<DeleteAcademyResult> {
  const allowed = await hasPermission(actorContext, DELETE_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = academyIdSchema.safeParse(academyId);
  if (!parsedId.success) {
    return { ok: false, error: { code: "validation", message: parsedId.error.issues[0]?.message ?? "Invalid input." } };
  }

  const result = await db.transaction(async (tx) => {
    const [academy] = await tx
      .select({ id: academies.id, name: academies.name, logoRef: academies.logoRef })
      .from(academies)
      .where(eq(academies.id, parsedId.data))
      .for("update");
    if (!academy) {
      return { ok: false, error: { code: "not_found", message: "Academy not found." } } as const;
    }

    if (confirmedName !== academy.name) {
      return {
        ok: false,
        error: { code: "validation", message: "Type the exact academy name to confirm permanent deletion." },
      } as const;
    }

    const blockers = await computeDeletionBlockers(tx, academy.id);
    if (blockers.hasFinancialHistory) {
      return {
        ok: false,
        error: {
          code: "ineligible",
          message: "This academy cannot be permanently deleted because it has financial history (charges, payments, income, or expenses). Close it instead.",
        },
      } as const;
    }
    if (blockers.hasSubscriptionPayments) {
      return {
        ok: false,
        error: {
          code: "ineligible",
          message: "This academy cannot be permanently deleted because subscription payments have been recorded for it. Close it instead.",
        },
      } as const;
    }
    if (blockers.hasCertificates) {
      return {
        ok: false,
        error: {
          code: "ineligible",
          message: "This academy cannot be permanently deleted because certificates have been issued. Close it instead.",
        },
      } as const;
    }
    if (blockers.hasExamResults) {
      return {
        ok: false,
        error: {
          code: "ineligible",
          message: "This academy cannot be permanently deleted because exam results exist. Close it instead.",
        },
      } as const;
    }

    // Audit the deletion itself before removing anything — `academyId` can
    // still legally reference the (about-to-be-removed) row at this point;
    // it gets detached, not deleted, in the very last step below.
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: academy.id,
        action: "deleteAcademy",
        entityType: "academy",
        entityId: academy.id,
        before: { name: academy.name },
      },
      tx,
    );

    // Disposable dependent data, deepest children first. Every table here
    // is guaranteed to hold no financial/subscription-payment/certificate/
    // exam-result rows (checked above) — nothing protected is ever reached
    // by this list.
    await tx.delete(staffDocuments).where(eq(staffDocuments.academyId, academy.id));
    await tx.delete(studentDocuments).where(eq(studentDocuments.academyId, academy.id));
    await tx.delete(studentIdCards).where(eq(studentIdCards.academyId, academy.id));
    await tx.delete(notificationPreferences).where(eq(notificationPreferences.academyId, academy.id));
    await tx.delete(notifications).where(eq(notifications.academyId, academy.id));
    await tx.delete(academyUsage).where(eq(academyUsage.academyId, academy.id));
    await tx.delete(approvalRequests).where(eq(approvalRequests.academyId, academy.id));
    await tx.delete(staffBranchAssignments).where(eq(staffBranchAssignments.academyId, academy.id));
    await tx.delete(batchTrainerAssignments).where(eq(batchTrainerAssignments.academyId, academy.id));
    await tx.delete(batchEnrollments).where(eq(batchEnrollments.academyId, academy.id));
    await tx.delete(timetables).where(eq(timetables.academyId, academy.id));

    // Guaranteed empty by the eligibility gate (hasExamResults) — deleted
    // defensively anyway, in FK order, rather than assumed.
    await tx.delete(resultCorrections).where(eq(resultCorrections.academyId, academy.id));
    await tx.delete(examResults).where(eq(examResults.academyId, academy.id));
    await tx.delete(exams).where(eq(exams.academyId, academy.id));

    // grade_bands has no academy_id of its own — reached only through this
    // academy's grade_configurations rows.
    const configs = await tx
      .select({ id: gradeConfigurations.id })
      .from(gradeConfigurations)
      .where(eq(gradeConfigurations.academyId, academy.id));
    if (configs.length > 0) {
      await tx.delete(gradeBands).where(inArray(gradeBands.gradeConfigurationId, configs.map((c) => c.id)));
    }
    await tx.delete(gradeConfigurations).where(eq(gradeConfigurations.academyId, academy.id));

    await tx.delete(batches).where(eq(batches.academyId, academy.id));
    await tx.delete(courses).where(eq(courses.academyId, academy.id));
    await tx.delete(programs).where(eq(programs.academyId, academy.id));
    await tx.delete(staffProfiles).where(eq(staffProfiles.academyId, academy.id));
    await tx.delete(students).where(eq(students.academyId, academy.id));
    await tx.delete(branches).where(eq(branches.academyId, academy.id));
    await tx.delete(academyMemberships).where(eq(academyMemberships.academyId, academy.id));

    // Guaranteed empty by the eligibility gate (hasSubscriptionPayments) —
    // deleted defensively before the subscription row(s) that reference it.
    await tx.delete(subscriptionPayments).where(eq(subscriptionPayments.academyId, academy.id));
    await tx.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academy.id));

    // Preserve every historical audit row for this academy — including the
    // "deleteAcademy" row just inserted above — by detaching the FK rather
    // than deleting them. auditLogs.academyId is nullable specifically for
    // this (see this file's and the schema's own comments).
    await tx.update(auditLogs).set({ academyId: null }).where(eq(auditLogs.academyId, academy.id));

    await tx.delete(academies).where(eq(academies.id, academy.id));

    return { ok: true, academyId: academy.id, logoRef: academy.logoRef } as const;
  });

  if (!result.ok) {
    return result;
  }

  // R2 cleanup happens here, after the transaction has already committed —
  // Postgres and Cloudflare R2 cannot share one atomic transaction (see
  // this task's own "PostgreSQL transactions cannot atomically include
  // Cloudflare R2" instruction), so this is deliberately best-effort and
  // never rolls back the (already-successful, already-irreversible) academy
  // deletion over a storage cleanup failure. Failure is logged as a safe,
  // observable operational warning, same convention as
  // lib/academies/academy-logo.ts's own replacement/removal cleanup.
  if (result.logoRef) {
    const deleted = await deleteObject(result.logoRef);
    if (!deleted.ok) {
      logger.warn("academy deletion: logo R2 object could not be deleted (orphaned)", {
        academyId: result.academyId,
      });
    }
  }

  return { ok: true, academyId: result.academyId };
}
