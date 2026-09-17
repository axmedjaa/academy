import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { academies, approvalRequests, expenseRecords } from "@/lib/db/schema";
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
 * Permission gating and the create-vs-approve split
 * ---------------------------------------------------------------------
 * `ACADEMY_EXPENSES_ACTION`: Owner = "view", Admin/Manager = "approve",
 * Finance Officer = "manage", Trainer = "view", Admissions Officer = no
 * entry ("none"). Two distinct, non-overlapping gates:
 *
 *  - `canCreate` (`level === "manage"`, Finance Officer only) — gates
 *    `createExpenseRecord` AND `submitExpenseForApproval` (the creator
 *    submits their own draft).
 *  - `canApprove` (`level === "approve"`, Admin/Manager only) — gates
 *    `approveExpense`/`rejectExpense`.
 *
 * ---------------------------------------------------------------------
 * Judgment call — Admin/Manager are refused on `createExpenseRecord`
 * ---------------------------------------------------------------------
 * PLAN.md's Master Permission Matrix names this row "Expenses
 * (create/approve)" but its per-role cells are View(owner)/Approve(admin)/
 * Approve(manager)/—/Create-Submit(finance_officer)/View(trainer) — nothing
 * in that row's own text grants Admin or Manager a *create* capability,
 * only Approve. The Finance Lifecycle table is even more explicit: "draft
 * -> pending_approval (submitExpenseForApproval, by Finance Officer per its
 * Create/Submit cell)" names Finance Officer as the only actor for the
 * create/submit half of this entity's lifecycle; Admin/Manager's actor
 * column only ever appears on the approve/reject transition. Since
 * `ACADEMY_EXPENSES_ACTION`'s "approve" level is a distinct value from
 * "manage" (not a superset — see academy-permissions.ts's own comment: this
 * row's "approve" level exists specifically because Admin's cell here needs
 * to be Approve-only, unlike its Owner-gets-View-here quirk), gating
 * `createExpenseRecord` on `canCreate` (`level === "manage"` exactly, not
 * `canManage`'s more permissive "full-or-manage") already, structurally,
 * refuses Admin/Manager — no extra check needed. This is confirmed, not
 * merely assumed: student-payments.test.ts's sibling module documents the
 * analogous inversion explicitly, and this file's own test suite asserts
 * Admin/Manager get `forbidden` on `createExpenseRecord` while still
 * passing `approveExpense`/`rejectExpense`.
 */
function canCreate(level: AcademyPermissionLevel): boolean {
  return level === "manage";
}

function canApprove(level: AcademyPermissionLevel): boolean {
  return level === "approve";
}

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
      /** Can create/submit (canCreate's "manage"-only gate, Finance
       * Officer). */
      canCreate: boolean;
      /** Can approve/reject (canApprove's "approve"-only gate,
       * Admin/Manager). */
      canApprove: boolean;
    }
  | { ok: false; error: ExpenseRecordActionError };

export async function listExpenseRecords(actorContext: AuthContext): Promise<ListExpenseRecordsResult> {
  const resolved = await resolveExpenseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel } = resolved.access;

  const rows = await db.select().from(expenseRecords).where(eq(expenseRecords.academyId, academyId));

  return {
    ok: true,
    records: rows.map(toRecord),
    canCreate: canCreate(permissionLevel),
    canApprove: canApprove(permissionLevel),
  };
}

export type CreateExpenseRecordResult =
  | { ok: true; record: ExpenseRecordRecord }
  | { ok: false; error: ExpenseRecordActionError };

/** Finance Lifecycle table: `— -> draft`, actor Finance Officer only. */
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

    return row;
  });

  return { ok: true, record: toRecord(result) };
}

export type SubmitExpenseForApprovalResult =
  | { ok: true; record: ExpenseRecordRecord }
  | { ok: false; error: ExpenseRecordActionError };

/**
 * Finance Lifecycle table: `draft -> pending_approval`, actor Finance
 * Officer (same `canCreate` gate as `createExpenseRecord` — "the
 * creator/Finance Officer submits their own draft," per this item's
 * brief). Flips the expense's own status AND creates the
 * `entityType: "expense"` `approval_requests` row (Item 50a's
 * `createApprovalRequest`) in one transaction — same shape as
 * lib/academies/grade-configurations.ts's `submitGradeConfigForApproval`.
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
 * Finance Lifecycle table: `pending_approval -> approved`, actor Academy
 * Administrator or Manager only (`canApprove`'s `level === "approve"` gate
 * — Owner is View-only on this row, Finance Officer is Create/Submit-only,
 * neither ever reaches "approve"). Delegates the actual decision —
 * including the self-approval block and one-shot-decision guard — to Item
 * 50a's `decideApprovalRequest`; this function's own added value is
 * resolving which pending `approval_requests` row belongs to this expense
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

  if (!canApprove(permissionLevel)) {
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

    const decision = await decideApprovalRequest(tx, pending.id, {
      decidedBy: actorContext.userId,
      status: "approved",
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
 * required", same approval authority as `approveExpense`. Same
 * `canApprove`/`decideApprovalRequest` delegation, plus persisting the
 * required reason onto BOTH the `approval_requests` row (same convention
 * as `rejectGradeConfig`, since `decideApprovalRequest`'s own input shape
 * has no reason-at-decision-time field) and `expense_records.rejection_reason`
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

  if (!canApprove(permissionLevel)) {
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

    const decision = await decideApprovalRequest(tx, pending.id, {
      decidedBy: actorContext.userId,
      status: "rejected",
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
