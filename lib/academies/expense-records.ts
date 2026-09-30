import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { academies, approvalRequests, branches, expenseRecords } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_EXPENSES_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { createApprovalRequest, decideApprovalRequest } from "@/lib/academies/approval-requests";

/**
 * PLAN.md Phase 4, Item 53 — `createExpenseRecord`, `submitExpenseForApproval`,
 * `approveExpense`, `rejectExpense`, `listExpenseRecords`.
 *
 * ---------------------------------------------------------------------
 * Permission gating (as later revised — see ACADEMY_EXPENSES_ACTION's own
 * comment in lib/auth/academy-permissions.ts for the full history)
 * ---------------------------------------------------------------------
 * `ACADEMY_EXPENSES_ACTION`: Owner/Finance Officer = "manage", Admin/Manager
 * = "approve", Trainer = "view", Admissions Officer = no entry ("none").
 *
 *  - `canCreate` (`level === "manage" || level === "approve"`) — now ALL
 *    FOUR of Owner/Admin/Manager/Finance Officer, so every role that must
 *    be able to "record/record their own Expense" per the approved
 *    architecture decision can. Gates `createExpenseRecord` AND
 *    `submitExpenseForApproval`.
 *  - `canApprove` (`level === "approve"`, Admin/Manager only, UNCHANGED) —
 *    GENERAL approve authority: may decide ANY pending expense, their own
 *    or someone else's. Still gates `approveExpense`/`rejectExpense`'s
 *    outer permission check, same as before.
 *  - `SELF_APPROVE_ROLES` (Owner/Admin/Manager/Finance Officer) — NEW.
 *    Independent of `canApprove`: a role in this set may decide a pending
 *    expense it did NOT submit only when it also holds general
 *    `canApprove` authority (Admin/Manager); when it does NOT
 *    (Owner/Finance Officer), it may still decide a request ONLY when
 *    `pending.requestedBy === actorContext.userId` — enforced explicitly in
 *    `approveExpense`/`rejectExpense` below, since `decideApprovalRequest`
 *    itself has no concept of "may decide only their own but nobody
 *    else's" (its own guard is purely "self vs. not-self," never "is this
 *    actor allowed to decide non-self requests at all" — that authorization
 *    question is always the caller's job, per this module's own comment).
 *    `allowSelfDecision: SELF_APPROVE_ROLES.has(membershipRole)` is what
 *    actually lets `requestedBy === decidedBy` through
 *    `decideApprovalRequest`'s own guard for all four roles.
 *
 * This is the first entity in this codebase where self-decide is granted
 * to a role (Finance Officer) that never independently reaches the
 * entity's own general "approve" level at all — contrast
 * grade-configurations.ts/results.ts, where self-decide was always "the
 * actor already independently qualifies for both the create gate and the
 * approve gate," never a role-specific carve-out for a role lacking
 * general approve authority.
 */
function canCreate(level: AcademyPermissionLevel): boolean {
  return level === "manage" || level === "approve";
}

function canApprove(level: AcademyPermissionLevel): boolean {
  return level === "approve";
}

/** Roles allowed to decide (approve/reject) a pending expense THEY
 * THEMSELVES submitted, even without general `canApprove` authority — see
 * this file's own module comment. Admin/Manager are included here too
 * (harmless/redundant for them, since `canApprove` already lets them
 * decide anyone's) so `allowSelfDecision` is computed identically for all
 * four roles without a role-by-role special case. */
const SELF_APPROVE_ROLES = new Set<AcademyRole>([
  "academy_owner",
  "academy_admin",
  "manager",
  "finance_officer",
]);

function canView(level: AcademyPermissionLevel): boolean {
  return level !== "none";
}

export interface ExpenseRecordActionError {
  code:
    | "forbidden"
    | "validation"
    | "not_found"
    | "blocked"
    | "invalid_state"
    // decideApprovalRequest's (Item 50a) two guard failures, surfaced as-is
    // rather than collapsed into "forbidden" — same convention as
    // lib/academies/grade-configurations.ts's GradeConfigActionError.
    | "self_approval"
    | "already_decided";
  message: string;
}

const FORBIDDEN: ExpenseRecordActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's expense records.",
};

const NOT_FOUND: ExpenseRecordActionError = {
  code: "not_found",
  message: "Expense record not found.",
};

// Same IDOR-safe wording as lib/academies/branches.ts's own NOT_FOUND — a
// branchId belonging to a different academy must look identical to a
// nonexistent one.
const BRANCH_NOT_FOUND: ExpenseRecordActionError = {
  code: "not_found",
  message: "Branch not found.",
};

export const createExpenseRecordSchema = z.object({
  branchId: z.string().uuid("Invalid branch id").optional(),
  category: z.string().trim().min(1, "Category is required").max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  amountCents: z
    .number()
    .int("Amount must be a whole number of cents")
    .nonnegative("Amount cannot be negative"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "Currency must be a 3-letter code, e.g. USD")
    .optional(),
});

export type CreateExpenseRecordInput = z.input<typeof createExpenseRecordSchema>;

export const rejectExpenseReasonSchema = z
  .string()
  .trim()
  .min(1, "A rejection reason is required.")
  .max(2000);

export interface ExpenseRecordRecord {
  id: string;
  academyId: string;
  branchId: string | null;
  category: string;
  description: string | null;
  amountCents: number;
  currency: string;
  submittedBy: string;
  status: "draft" | "pending_approval" | "approved" | "rejected" | "reversed";
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  reversedRecordId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: typeof expenseRecords.$inferSelect): ExpenseRecordRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    branchId: row.branchId,
    category: row.category,
    description: row.description,
    amountCents: row.amountCents,
    currency: row.currency,
    submittedBy: row.submittedBy,
    status: row.status,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    rejectionReason: row.rejectionReason,
    reversedRecordId: row.reversedRecordId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Same per-academy `default_currency` resolution as
 * lib/academies/student-payments.ts's `resolveCurrency` — kept as its own
 * file-local copy, same reasoning as lib/academies/income-records.ts's. */
async function resolveCurrency(
  executor: DbClient,
  academyId: string,
  provided: string | undefined,
): Promise<string> {
  if (provided) return provided;
  const [academy] = await executor
    .select({ defaultCurrency: academies.defaultCurrency })
    .from(academies)
    .where(eq(academies.id, academyId))
    .limit(1);
  return academy?.defaultCurrency ?? "USD";
}

// Same per-file local copy as lib/academies/batches.ts's
// branchExistsInAcademy — verifies a client-supplied branchId actually
// belongs to the caller's own academy, not just that it exists somewhere.
async function branchExistsInAcademy(
  executor: DbClient,
  academyId: string,
  branchId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.academyId, academyId)))
    .limit(1);
  return Boolean(row);
}

interface ResolvedExpenseAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveExpenseAccessResult =
  | { ok: true; access: ResolvedExpenseAccess }
  | { ok: false; error: ExpenseRecordActionError };

async function resolveExpenseAccess(actorContext: AuthContext): Promise<ResolveExpenseAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(access.membershipRole, ACADEMY_EXPENSES_ACTION);
  if (!canView(permissionLevel)) {
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

export type ListExpenseRecordsResult =
  | {
      ok: true;
      records: ExpenseRecordRecord[];
      /** Can create/submit — Owner/Admin/Manager/Finance Officer, all four,
       * per the approved architecture decision. */
      canCreate: boolean;
      /** GENERAL approve authority — may decide ANY pending expense, not
       * just their own. Admin/Manager only, unchanged. Also still exactly
       * what `canReverseExpense` (lib/academies/finance-reversals.ts)
       * requires, so this flag continues to correctly gate the UI's
       * Reverse/Adjust controls with no change needed there. */
      canApprove: boolean;
      /** May decide a pending expense THEY THEMSELVES submitted, even
       * without general approve authority — true for all four of
       * Owner/Admin/Manager/Finance Officer. The UI must combine this with
       * a per-row `record.submittedBy === currentUserId` check (this flag
       * alone does not mean "can decide any row" — only `canApprove`
       * means that) to decide whether to show Approve/Reject on a given
       * row. See this file's own module comment. */
      canSelfApprove: boolean;
    }
  | { ok: false; error: ExpenseRecordActionError };

export async function listExpenseRecords(actorContext: AuthContext): Promise<ListExpenseRecordsResult> {
  const resolved = await resolveExpenseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const rows = await db.select().from(expenseRecords).where(eq(expenseRecords.academyId, academyId));

  return {
    ok: true,
    records: rows.map(toRecord),
    canCreate: canCreate(permissionLevel),
    canApprove: canApprove(permissionLevel),
    canSelfApprove: SELF_APPROVE_ROLES.has(membershipRole),
  };
}

export type CreateExpenseRecordResult =
  | { ok: true; record: ExpenseRecordRecord }
  | { ok: false; error: ExpenseRecordActionError };

/** Finance Lifecycle table: `— -> draft`, originally Finance Officer only —
 * now Owner/Admin/Manager/Finance Officer, per `canCreate`'s widened gate
 * above (approved architecture decision). */
export async function createExpenseRecord(
  actorContext: AuthContext,
  input: CreateExpenseRecordInput,
): Promise<CreateExpenseRecordResult> {
  const resolved = await resolveExpenseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canCreate(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createExpenseRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    // Verify a supplied branchId actually belongs to this academy before
    // writing anything — the bare FK only proves the branch exists
    // *somewhere*. No record is created when this fails.
    if (data.branchId !== undefined) {
      const branchOk = await branchExistsInAcademy(tx, academyId, data.branchId);
      if (!branchOk) {
        return { outcome: "invalid_branch" as const };
      }
    }

    const currency = await resolveCurrency(tx, academyId, data.currency);

    const [row] = await tx
      .insert(expenseRecords)
      .values({
        academyId,
        branchId: data.branchId,
        category: data.category,
        description: data.description,
        amountCents: data.amountCents,
        currency,
        submittedBy: actorContext.userId,
      })
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "createExpenseRecord",
        entityType: "expense_record",
        entityId: row.id,
        after: toRecord(row),
      },
      tx,
    );

    return { outcome: "ok" as const, row };
  });

  if (result.outcome === "invalid_branch") {
    return { ok: false, error: BRANCH_NOT_FOUND };
  }
  return { ok: true, record: toRecord(result.row) };
}

export type SubmitExpenseForApprovalResult =
  | { ok: true; record: ExpenseRecordRecord }
  | { ok: false; error: ExpenseRecordActionError };

/**
 * Finance Lifecycle table: `draft -> pending_approval`, same `canCreate`
 * gate as `createExpenseRecord` (originally Finance Officer only — now
 * Owner/Admin/Manager/Finance Officer, "the creator submits their own
 * draft"). Flips the expense's own status AND creates the
 * `entityType: "expense"` `approval_requests` row (Item 50a's
 * `createApprovalRequest`) in one transaction — same shape as
 * lib/academies/grade-configurations.ts's `submitGradeConfigForApproval`.
 * No ownership check here — same as before, ANY create-capable role may
 * submit ANY draft in the academy (not just one they personally created),
 * matching this file's existing convention.
 */
export async function submitExpenseForApproval(
  actorContext: AuthContext,
  expenseRecordId: string,
): Promise<SubmitExpenseForApprovalResult> {
  const resolved = await resolveExpenseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canCreate(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(expenseRecordId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [expense] = await tx
      .select()
      .from(expenseRecords)
      .where(and(eq(expenseRecords.id, expenseRecordId), eq(expenseRecords.academyId, academyId)))
      .limit(1);
    if (!expense) {
      return { kind: "not_found" as const };
    }
    if (expense.status !== "draft") {
      return { kind: "invalid_state" as const };
    }

    const [updated] = await tx
      .update(expenseRecords)
      .set({ status: "pending_approval", updatedAt: new Date() })
      .where(eq(expenseRecords.id, expenseRecordId))
      .returning();

    const requestResult = await createApprovalRequest(tx, {
      academyId,
      entityType: "expense",
      entityId: expenseRecordId,
      requestedBy: actorContext.userId,
    });
    if (!requestResult.ok) {
      // Unreachable in practice — see grade-configurations.ts's identical
      // comment on this same defensive throw.
      throw new Error(`createApprovalRequest failed unexpectedly: ${requestResult.error.message}`);
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "submitExpenseForApproval",
        entityType: "expense_record",
        entityId: expenseRecordId,
        before: { status: expense.status },
        after: { status: updated.status, approvalRequestId: requestResult.request.id },
      },
      tx,
    );

    return { kind: "ok" as const, record: updated };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: NOT_FOUND };
  }
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "Only a draft expense can be submitted for approval." },
    };
  }
  return { ok: true, record: toRecord(result.record) };
}

/** Shared by `approveExpense`/`rejectExpense`: the one `pending`
 * `approval_requests` row for this expense, if any — same defensive
 * "treat a missing row as invalid_state, not not_found" convention as
 * lib/academies/grade-configurations.ts's `findPendingApprovalRequest`. */
async function findPendingApprovalRequest(tx: DbClient, expenseRecordId: string) {
  const [pending] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.entityType, "expense"),
        eq(approvalRequests.entityId, expenseRecordId),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);
  return pending ?? null;
}

function mapDecisionError(error: { code: string; message: string }): ExpenseRecordActionError {
  if (error.code === "self_approval" || error.code === "already_decided") {
    return { code: error.code, message: error.message };
  }
  return { code: "validation", message: error.message };
}

export type ApproveExpenseResult =
  | { ok: true; record: ExpenseRecordRecord }
  | { ok: false; error: ExpenseRecordActionError };

/**
 * Finance Lifecycle table: `pending_approval -> approved`. Two ways in,
 * per the approved architecture decision:
 *
 *  - GENERAL approve authority (`canApprove`, `level === "approve"`,
 *    Admin/Manager, unchanged): may decide ANY pending expense.
 *  - SELF-approve only (`SELF_APPROVE_ROLES`, all four of
 *    Owner/Admin/Manager/Finance Officer): may decide ONLY a request they
 *    themselves submitted — enforced explicitly below once the pending
 *    request is loaded (`pending.requestedBy`), since neither the outer
 *    permission gate nor `decideApprovalRequest` itself can express "may
 *    decide only their own but nobody else's."
 *
 * Delegates the actual decision — including the one-shot-decision guard —
 * to Item 50a's `decideApprovalRequest`, passing
 * `allowSelfDecision: SELF_APPROVE_ROLES.has(membershipRole)` so
 * `requestedBy === decidedBy` is no longer unconditionally refused for
 * these four roles. This function's own added value is resolving which
 * pending `approval_requests` row belongs to this expense, enforcing the
 * "self-approve-only roles may not decide someone else's request" rule,
 * and flipping the expense's own `status`/`approved_by`/`approved_at` in
 * the same transaction as that decision.
 */
export async function approveExpense(
  actorContext: AuthContext,
  expenseRecordId: string,
): Promise<ApproveExpenseResult> {
  const resolved = await resolveExpenseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const hasGeneralApprove = canApprove(permissionLevel);
  const isSelfApproveRole = SELF_APPROVE_ROLES.has(membershipRole);
  if (!hasGeneralApprove && !isSelfApproveRole) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(expenseRecordId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [expense] = await tx
      .select()
      .from(expenseRecords)
      .where(and(eq(expenseRecords.id, expenseRecordId), eq(expenseRecords.academyId, academyId)))
      .limit(1);
    if (!expense) {
      return { kind: "not_found" as const };
    }
    if (expense.status !== "pending_approval") {
      return { kind: "invalid_state" as const };
    }

    const pending = await findPendingApprovalRequest(tx, expenseRecordId);
    if (!pending) {
      return { kind: "invalid_state" as const };
    }

    // A self-approve-only role (no general authority) may decide ONLY a
    // request it submitted itself — never someone else's, even though it
    // passed the outer gate above.
    if (!hasGeneralApprove && pending.requestedBy !== actorContext.userId) {
      return { kind: "forbidden" as const };
    }

    const decision = await decideApprovalRequest(tx, pending.id, {
      decidedBy: actorContext.userId,
      status: "approved",
      allowSelfDecision: isSelfApproveRole,
    });
    if (!decision.ok) {
      return { kind: "decision_error" as const, error: decision.error };
    }

    const [updated] = await tx
      .update(expenseRecords)
      .set({
        status: "approved",
        approvedBy: actorContext.userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(expenseRecords.id, expenseRecordId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "approveExpense",
        entityType: "expense_record",
        entityId: expenseRecordId,
        before: { status: expense.status },
        after: { status: updated.status, approvedBy: updated.approvedBy },
      },
      tx,
    );

    return { kind: "ok" as const, record: updated };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: NOT_FOUND };
  }
  if (result.kind === "forbidden") {
    return { ok: false, error: FORBIDDEN };
  }
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "Only an expense pending approval can be approved." },
    };
  }
  if (result.kind === "decision_error") {
    return { ok: false, error: mapDecisionError(result.error) };
  }
  return { ok: true, record: toRecord(result.record) };
}

export type RejectExpenseResult =
  | { ok: true; record: ExpenseRecordRecord }
  | { ok: false; error: ExpenseRecordActionError };

/**
 * Finance Lifecycle table: `pending_approval -> rejected`, "reason
 * required", same authority split as `approveExpense` — see that
 * function's own comment. Same `canApprove`/self-approve-role/
 * `decideApprovalRequest` delegation, plus persisting the required reason
 * onto BOTH the `approval_requests` row (same convention as
 * `rejectGradeConfig`, since `decideApprovalRequest`'s own input shape has
 * no reason-at-decision-time field) and `expense_records.rejection_reason`
 * itself (a real schema column on this table, unlike `grade_configurations`).
 */
export async function rejectExpense(
  actorContext: AuthContext,
  expenseRecordId: string,
  reason: string,
): Promise<RejectExpenseResult> {
  const resolved = await resolveExpenseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const hasGeneralApprove = canApprove(permissionLevel);
  const isSelfApproveRole = SELF_APPROVE_ROLES.has(membershipRole);
  if (!hasGeneralApprove && !isSelfApproveRole) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(expenseRecordId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsedReason = rejectExpenseReasonSchema.safeParse(reason);
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
    const [expense] = await tx
      .select()
      .from(expenseRecords)
      .where(and(eq(expenseRecords.id, expenseRecordId), eq(expenseRecords.academyId, academyId)))
      .limit(1);
    if (!expense) {
      return { kind: "not_found" as const };
    }
    if (expense.status !== "pending_approval") {
      return { kind: "invalid_state" as const };
    }

    const pending = await findPendingApprovalRequest(tx, expenseRecordId);
    if (!pending) {
      return { kind: "invalid_state" as const };
    }

    // A self-approve-only role (no general authority) may decide ONLY a
    // request it submitted itself — never someone else's.
    if (!hasGeneralApprove && pending.requestedBy !== actorContext.userId) {
      return { kind: "forbidden" as const };
    }

    const decision = await decideApprovalRequest(tx, pending.id, {
      decidedBy: actorContext.userId,
      status: "rejected",
      allowSelfDecision: isSelfApproveRole,
    });
    if (!decision.ok) {
      return { kind: "decision_error" as const, error: decision.error };
    }

    await tx
      .update(approvalRequests)
      .set({ reason: parsedReason.data })
      .where(eq(approvalRequests.id, pending.id));

    const [updated] = await tx
      .update(expenseRecords)
      .set({ status: "rejected", rejectionReason: parsedReason.data, updatedAt: new Date() })
      .where(eq(expenseRecords.id, expenseRecordId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "rejectExpense",
        entityType: "expense_record",
        entityId: expenseRecordId,
        before: { status: expense.status },
        after: { status: updated.status, rejectionReason: parsedReason.data },
      },
      tx,
    );

    return { kind: "ok" as const, record: updated };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: NOT_FOUND };
  }
  if (result.kind === "forbidden") {
    return { ok: false, error: FORBIDDEN };
  }
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "Only an expense pending approval can be rejected." },
    };
  }
  if (result.kind === "decision_error") {
    return { ok: false, error: mapDecisionError(result.error) };
  }
  return { ok: true, record: toRecord(result.record) };
}
