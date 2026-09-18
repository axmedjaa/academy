import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  academies,
  approvalRequests,
  receipts,
  studentCharges,
  studentPayments,
  students,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_STUDENT_PAYMENTS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { createApprovalRequest, decideApprovalRequest } from "@/lib/academies/approval-requests";
import { enqueueNotification } from "@/lib/notifications/notifications";
import { logger } from "@/lib/logger";

/**
 * PLAN.md Phase 4, Item 51 — "createStudentCharge, recordStudentPayment,
 * issueReceipt." Item 52 — "approveStudentPayment/rejectStudentPayment +
 * self-approval rejection test" — is also implemented in this file (see
 * `canApprove`, `approveStudentPayment`, `rejectStudentPayment` below).
 *
 * ---------------------------------------------------------------------
 * Permission gating
 * ---------------------------------------------------------------------
 * lib/auth/academy-permissions.ts's `ACADEMY_STUDENT_PAYMENTS_ACTION` row
 * (see its own module comment for the full derivation): Owner/Admin/Trainer
 * = "view", Manager = "full", Finance Officer = "manage", Admissions
 * Officer = no entry ("none"). `canManage`'s "full"-or-"manage" gate below
 * is deliberately the SAME gate for both Manager and Finance Officer —
 * both may create/record/issue. `canApprove`'s narrower `level === "full"`
 * gate (Item 52, further down this file) is a DIFFERENT, stricter gate used
 * only by `approveStudentPayment`/`rejectStudentPayment`: Finance Officer's
 * "manage" level passes `canManage` but never `canApprove`, so they can
 * record a payment but never decide one — not even their own, and not even
 * someone else's. Owner/Admin (view-only) and Trainer (view-only) are
 * refused on every action in this file — the confirmed inversion from this
 * codebase's usual pattern (Owner/Admin normally reach "full" everywhere
 * else) called out explicitly in this item's own brief and covered by an
 * explicit permission-matrix test in student-payments.test.ts.
 *
 * ---------------------------------------------------------------------
 * Judgment call: no branch-scoping on the read side
 * ---------------------------------------------------------------------
 * `ACADEMY_STUDENT_PAYMENTS_ACTION`'s own comment in academy-permissions.ts
 * speculates that Trainer's "view" could, in practice, be branch-scoped
 * (DESIGN.md §5's general branch-scope note). This item's brief lists no
 * such requirement anywhere in its explicit test list, `student_charges`
 * carries no `branch_id` column at all (PLAN.md's column list for this
 * table), and building it would mean joining through `students.branch_id`
 * plus `staff_branch_assignments` — real, unrequested scope. `listStudentCharges`/
 * `listStudentPayments` below are therefore academy-wide reads for every
 * non-"none" permission level, exactly like `listGradeConfigurations`. Left
 * as an explicit, documented judgment call rather than silently expanded.
 *
 * ---------------------------------------------------------------------
 * Currency defaulting
 * ---------------------------------------------------------------------
 * PLAN.md: "currency text NOT NULL default academy's default_currency."
 * That default is a per-academy value, not a fixed literal a DB column
 * default can express — `resolveCurrency` below resolves it from the
 * academy row itself whenever the caller doesn't supply one explicitly.
 *
 * ---------------------------------------------------------------------
 * Cross-academy/tenant integrity
 * ---------------------------------------------------------------------
 * Same "fetch the referenced row, then compare its own academyId to the
 * expected one" shape as lib/academies/batch-assignments.ts's
 * `enrollStudentInBatch` (itself following
 * lib/subscriptions/payments.ts's recordSubscriptionPayment pattern):
 * the target student must belong to the caller's academy, and a payment's
 * `chargeId` (if given) must belong to the same student AND academy. A
 * mismatch (or a nonexistent id) always returns the identical generic
 * "not found" — never a distinguishing error that would confirm a guessed
 * id exists in some other academy.
 */
function canManage(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

/**
 * PLAN.md Phase 4, Item 52 — `approveStudentPayment`/`rejectStudentPayment`
 * gate. Per this row's own module comment above (`ACADEMY_STUDENT_PAYMENTS_ACTION`),
 * only `level === "full"` (Manager) passes — Finance Officer's `"manage"`
 * level deliberately does NOT reach approve/reject, even for a payment
 * someone else recorded: the Finance Lifecycle table's `student_payments`
 * row names Manager as the sole approver ("never the recorder" — and never
 * Finance Officer at all, regardless of whose submission it is). Owner/Admin
 * (`"view"`) and everyone else are refused by the same gate.
 */
function canApprove(level: AcademyPermissionLevel): boolean {
  return level === "full";
}

export interface StudentPaymentsActionError {
  code:
    | "forbidden"
    | "validation"
    | "not_found"
    | "blocked"
    | "conflict"
    | "invalid_state"
    // Row-locked "already processed" concurrency guard (PLAN.md's
    // Concurrency & Idempotency table: "Payment verification
    // (verifySubscriptionPayment, approveStudentPayment) — row-locked status
    // check — two concurrent calls on the same row: one succeeds, one gets a
    // clear 'already processed' error") — kept distinct from `invalid_state`
    // (used elsewhere in this file, e.g. issueReceipt's "must already be
    // approved" precondition) since this one is specifically about a
    // payment no longer being in `pending_approval` by the time the row lock
    // is acquired.
    | "already_processed"
    // decideApprovalRequest's (Item 50a) two guard failures, surfaced as-is
    // rather than collapsed into "forbidden"/"validation" — same convention
    // as lib/academies/expense-records.ts's ExpenseRecordActionError.
    | "self_approval"
    | "already_decided";
  message: string;
}

const FORBIDDEN: StudentPaymentsActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's student payments.",
};

const STUDENT_NOT_FOUND: StudentPaymentsActionError = {
  code: "not_found",
  message: "Student not found.",
};

const CHARGE_NOT_FOUND: StudentPaymentsActionError = {
  code: "not_found",
  message: "Charge not found.",
};

const PAYMENT_NOT_FOUND: StudentPaymentsActionError = {
  code: "not_found",
  message: "Payment not found.",
};

const RECEIPT_NOT_FOUND: StudentPaymentsActionError = {
  code: "not_found",
  message: "Receipt not found.",
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

const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, "Currency must be a 3-letter code, e.g. USD")
  .optional();

export const createStudentChargeSchema = z.object({
  studentId: z.string().uuid("Invalid student id"),
  description: z.string().trim().min(1, "Description is required").max(500),
  amountCents: z
    .number()
    .int("Amount must be a whole number of cents")
    .nonnegative("Amount cannot be negative"),
  currency: currencySchema,
  dueDate: optionalText(20),
});

export type CreateStudentChargeInput = z.input<typeof createStudentChargeSchema>;

export const recordStudentPaymentSchema = z.object({
  studentId: z.string().uuid("Invalid student id"),
  chargeId: z.string().uuid("Invalid charge id").optional(),
  amountCents: z
    .number()
    .int("Amount must be a whole number of cents")
    .nonnegative("Amount cannot be negative"),
  currency: currencySchema,
  method: z.enum(["cash", "mobile_money", "bank_transfer"]),
  reference: optionalText(200),
  receivedAt: z.coerce.date({ message: "A valid received date is required" }),
});

export type RecordStudentPaymentInput = z.input<typeof recordStudentPaymentSchema>;

export const issueReceiptSchema = z.object({
  issuedAt: z.coerce.date().optional(),
});

export type IssueReceiptInput = z.input<typeof issueReceiptSchema>;

/**
 * Item 52 — same non-empty-reason requirement as
 * lib/academies/expense-records.ts's `rejectExpenseReasonSchema`. No
 * `rejection_reason` column exists on `student_payments` (see
 * lib/db/schema.ts's column list for this table — only `reversal_reason`,
 * for Item 54's later reversal action), so the reason is persisted onto the
 * `approval_requests` row only, same convention as this codebase's
 * `rejectGradeConfig`.
 */
export const rejectStudentPaymentReasonSchema = z
  .string()
  .trim()
  .min(1, "A rejection reason is required.")
  .max(2000);

export interface StudentChargeRecord {
  id: string;
  academyId: string;
  studentId: string;
  description: string;
  amountCents: number;
  currency: string;
  dueDate: string | null;
  status: "open" | "partially_paid" | "paid" | "cancelled";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StudentPaymentRecord {
  id: string;
  academyId: string;
  studentId: string;
  chargeId: string | null;
  amountCents: number;
  currency: string;
  method: "cash" | "mobile_money" | "bank_transfer";
  reference: string | null;
  receivedAt: Date;
  recordedBy: string;
  status: "pending_approval" | "approved" | "rejected" | "reversed";
  approvedBy: string | null;
  approvedAt: Date | null;
  reversedPaymentId: string | null;
  reversalReason: string | null;
  createdAt: Date;
}

export interface ReceiptRecord {
  id: string;
  academyId: string;
  studentPaymentId: string;
  receiptNumber: string;
  issuedAt: Date;
  issuedBy: string;
  createdAt: Date;
}

function toChargeRecord(row: typeof studentCharges.$inferSelect): StudentChargeRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    studentId: row.studentId,
    description: row.description,
    amountCents: row.amountCents,
    currency: row.currency,
    dueDate: row.dueDate,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPaymentRecord(row: typeof studentPayments.$inferSelect): StudentPaymentRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    studentId: row.studentId,
    chargeId: row.chargeId,
    amountCents: row.amountCents,
    currency: row.currency,
    method: row.method,
    reference: row.reference,
    receivedAt: row.receivedAt,
    recordedBy: row.recordedBy,
    status: row.status,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    reversedPaymentId: row.reversedPaymentId,
    reversalReason: row.reversalReason,
    createdAt: row.createdAt,
  };
}

function toReceiptRecord(row: typeof receipts.$inferSelect): ReceiptRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    studentPaymentId: row.studentPaymentId,
    receiptNumber: row.receiptNumber,
    issuedAt: row.issuedAt,
    issuedBy: row.issuedBy,
    createdAt: row.createdAt,
  };
}

/**
 * Resolves `currency` from the caller's input when given, otherwise from
 * the academy's own `default_currency` — PLAN.md's per-academy default
 * that a DB column default cannot express. Runs against the same
 * transaction executor as the caller's mutation so it sees a consistent
 * snapshot of the academy row.
 */
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
  // Defensive fallback only — academyId is always derived from a real,
  // already-verified access resolution, so `academy` should never be
  // missing in practice.
  return academy?.defaultCurrency ?? "USD";
}

/**
 * Postgres unique_violation (23505) detection — same double-wrapped-error
 * shape as every other `isUniqueViolation` in this codebase (drizzle-orm
 * wraps the raw `pg` DatabaseError in its own `DrizzleQueryError`, so
 * `code` lives on `err.cause`, not `err` itself).
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

interface ResolvedStudentPaymentsAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveStudentPaymentsAccessResult =
  | { ok: true; access: ResolvedStudentPaymentsAccess }
  | { ok: false; error: StudentPaymentsActionError };

async function resolveStudentPaymentsAccess(
  actorContext: AuthContext,
): Promise<ResolveStudentPaymentsAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(
    access.membershipRole,
    ACADEMY_STUDENT_PAYMENTS_ACTION,
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

export type ListStudentChargesResult =
  | { ok: true; charges: StudentChargeRecord[]; canManage: boolean }
  | { ok: false; error: StudentPaymentsActionError };

/** Academy-wide read (see this file's module comment on the no-branch-scoping
 * judgment call), optionally narrowed to one student. */
export async function listStudentCharges(
  actorContext: AuthContext,
  filters: { studentId?: string } = {},
): Promise<ListStudentChargesResult> {
  const resolved = await resolveStudentPaymentsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel } = resolved.access;

  const conditions = [eq(studentCharges.academyId, academyId)];
  if (filters.studentId) {
    conditions.push(eq(studentCharges.studentId, filters.studentId));
  }

  const rows = await db
    .select()
    .from(studentCharges)
    .where(and(...conditions));

  return { ok: true, charges: rows.map(toChargeRecord), canManage: canManage(permissionLevel) };
}

export type ListStudentPaymentsResult =
  | {
      ok: true;
      payments: StudentPaymentRecord[];
      canManage: boolean;
      /** UI-gap fix (Phase 4 audit, Item 52): whether this caller can
       * approve/reject/reverse/adjust a payment — `canApprove`'s stricter
       * "full" (Manager)-only gate, distinct from `canManage`'s
       * "full"-or-"manage" (also Finance Officer). Exposed here the same
       * way `listExpenseRecords` already exposes both its `canCreate` and
       * `canApprove` flags, so the UI can decide what to render without
       * re-deriving the permission level itself. */
      canApprove: boolean;
    }
  | { ok: false; error: StudentPaymentsActionError };

export async function listStudentPayments(
  actorContext: AuthContext,
  filters: { studentId?: string } = {},
): Promise<ListStudentPaymentsResult> {
  const resolved = await resolveStudentPaymentsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel } = resolved.access;

  const conditions = [eq(studentPayments.academyId, academyId)];
  if (filters.studentId) {
    conditions.push(eq(studentPayments.studentId, filters.studentId));
  }

  const rows = await db
    .select()
    .from(studentPayments)
    .where(and(...conditions));

  return {
    ok: true,
    payments: rows.map(toPaymentRecord),
    canManage: canManage(permissionLevel),
    canApprove: canApprove(permissionLevel),
  };
}

export type GetReceiptResult =
  | { ok: true; receipt: ReceiptRecord }
  | { ok: false; error: StudentPaymentsActionError };

/** Tenant-scoped single read. IDOR-safe: nonexistent or cross-academy id
 * both return the identical generic `not_found`. */
export async function getReceipt(
  actorContext: AuthContext,
  receiptId: string,
): Promise<GetReceiptResult> {
  const resolved = await resolveStudentPaymentsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const parsedId = z.string().uuid().safeParse(receiptId);
  if (!parsedId.success) {
    return { ok: false, error: RECEIPT_NOT_FOUND };
  }

  const [row] = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.academyId, academyId)))
    .limit(1);
  if (!row) {
    return { ok: false, error: RECEIPT_NOT_FOUND };
  }

  return { ok: true, receipt: toReceiptRecord(row) };
}

export type CreateStudentChargeResult =
  | { ok: true; charge: StudentChargeRecord }
  | { ok: false; error: StudentPaymentsActionError };

/**
 * PLAN.md §4/Finance Lifecycle: `createStudentCharge` — always starts
 * `open` (the table's own DB default), created by Manager or Finance
 * Officer, no approval step. Only `canManage` (Manager="full",
 * Finance Officer="manage") may call this — Owner/Admin/Trainer (view-only)
 * are refused.
 */
export async function createStudentCharge(
  actorContext: AuthContext,
  input: CreateStudentChargeInput,
): Promise<CreateStudentChargeResult> {
  const resolved = await resolveStudentPaymentsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createStudentChargeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [student] = await tx
      .select({ id: students.id, academyId: students.academyId })
      .from(students)
      .where(eq(students.id, data.studentId))
      .limit(1);
    if (!student || student.academyId !== academyId) {
      return { kind: "student_not_found" as const };
    }

    const currency = await resolveCurrency(tx, academyId, data.currency);

    const [row] = await tx
      .insert(studentCharges)
      .values({
        academyId,
        studentId: data.studentId,
        description: data.description,
        amountCents: data.amountCents,
        currency,
        dueDate: data.dueDate,
        createdBy: actorContext.userId,
      })
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "createStudentCharge",
        entityType: "student_charge",
        entityId: row.id,
        after: toChargeRecord(row),
      },
      tx,
    );

    return { kind: "ok" as const, row };
  });

  if (result.kind === "student_not_found") {
    return { ok: false, error: STUDENT_NOT_FOUND };
  }
  return { ok: true, charge: toChargeRecord(result.row) };
}

export type RecordStudentPaymentResult =
  | { ok: true; payment: StudentPaymentRecord }
  | { ok: false; error: StudentPaymentsActionError };

/**
 * PLAN.md §4/Finance Lifecycle: `recordStudentPayment` — always created
 * `pending_approval` (the table's own DB default); `approveStudentPayment`/
 * `rejectStudentPayment` are Item 52, not built here. Same `canManage` gate
 * as `createStudentCharge`.
 */
export async function recordStudentPayment(
  actorContext: AuthContext,
  input: RecordStudentPaymentInput,
): Promise<RecordStudentPaymentResult> {
  const resolved = await resolveStudentPaymentsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = recordStudentPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [student] = await tx
      .select({ id: students.id, academyId: students.academyId })
      .from(students)
      .where(eq(students.id, data.studentId))
      .limit(1);
    if (!student || student.academyId !== academyId) {
      return { kind: "student_not_found" as const };
    }

    if (data.chargeId) {
      const [charge] = await tx
        .select({
          id: studentCharges.id,
          academyId: studentCharges.academyId,
          studentId: studentCharges.studentId,
        })
        .from(studentCharges)
        .where(eq(studentCharges.id, data.chargeId))
        .limit(1);
      if (!charge || charge.academyId !== academyId || charge.studentId !== data.studentId) {
        return { kind: "charge_not_found" as const };
      }
    }

    const currency = await resolveCurrency(tx, academyId, data.currency);

    const [row] = await tx
      .insert(studentPayments)
      .values({
        academyId,
        studentId: data.studentId,
        chargeId: data.chargeId,
        amountCents: data.amountCents,
        currency,
        method: data.method,
        reference: data.reference,
        receivedAt: data.receivedAt,
        recordedBy: actorContext.userId,
      })
      .returning();

    // Item 52's confirmed gap fix: create the `approval_requests` row
    // (entityType "student_payment") in the same transaction as the insert,
    // mirroring lib/academies/expense-records.ts's
    // `submitExpenseForApproval` — without this, a pending payment never
    // surfaces in DESIGN.md's unified `/academy/finance/approvals` queue.
    const requestResult = await createApprovalRequest(tx, {
      academyId,
      entityType: "student_payment",
      entityId: row.id,
      requestedBy: actorContext.userId,
    });
    if (!requestResult.ok) {
      // Unreachable in practice — see grade-configurations.ts's/
      // expense-records.ts's identical comment on this same defensive
      // throw: the input we just built is always well-formed.
      throw new Error(`createApprovalRequest failed unexpectedly: ${requestResult.error.message}`);
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "recordStudentPayment",
        entityType: "student_payment",
        entityId: row.id,
        after: { ...toPaymentRecord(row), approvalRequestId: requestResult.request.id },
      },
      tx,
    );

    return { kind: "ok" as const, row };
  });

  if (result.kind === "student_not_found") {
    return { ok: false, error: STUDENT_NOT_FOUND };
  }
  if (result.kind === "charge_not_found") {
    return { ok: false, error: CHARGE_NOT_FOUND };
  }
  return { ok: true, payment: toPaymentRecord(result.row) };
}

const MAX_CANDIDATE_SCAN_ATTEMPTS = 1000;
// Generous on purpose, same reasoning as register-student.ts's
// MAX_INSERT_ATTEMPTS: each attempt is a full fresh transaction (see the
// module comment below on why a caught unique-violation can't be retried
// inside the same aborted transaction), so erring high costs little.
const MAX_INSERT_ATTEMPTS = 20;

function formatReceiptNumber(sequence: number): string {
  return `RCT-${String(sequence).padStart(6, "0")}`;
}

/**
 * Academy-scoped sequential receipt numbering (`RCT-000001`, `RCT-000002`,
 * ...), independent per academy — same "count existing + 1, then scan
 * forward past any already-taken candidate" shape as
 * register-student.ts's `generateStudentId`. This function's own scan is
 * still just a best-effort pre-check; the real safety net against a
 * genuine concurrent race for the same candidate is the
 * `(academy_id, receipt_number)` DB-level unique constraint, enforced at
 * insert time by `issueReceipt`'s retry loop below.
 */
async function generateReceiptNumber(executor: DbClient, academyId: string): Promise<string> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(receipts)
    .where(eq(receipts.academyId, academyId));

  let sequence = (row?.count ?? 0) + 1;

  for (let attempt = 0; attempt < MAX_CANDIDATE_SCAN_ATTEMPTS; attempt += 1) {
    const candidate = formatReceiptNumber(sequence);
    const [existing] = await executor
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.academyId, academyId), eq(receipts.receiptNumber, candidate)))
      .limit(1);
    if (!existing) return candidate;
    sequence += 1;
  }

  // Effectively unreachable — see generateStudentId's identical fallback.
  return formatReceiptNumber(sequence);
}

export type IssueReceiptResult =
  | { ok: true; receipt: ReceiptRecord }
  | { ok: false; error: StudentPaymentsActionError };

/**
 * PLAN.md's Finance Lifecycle table: "issued directly on payment approval
 * (issueReceipt) — no separate approval state." Hard precondition (this
 * item's own brief, not spelled out verbatim in PLAN.md): the target
 * `student_payments` row's `status` must already be `approved` — refused
 * with a specific `invalid_state` error otherwise. Same `canManage` gate as
 * create/record above.
 *
 * ---------------------------------------------------------------------
 * Why the retry loop wraps a *fresh* transaction each attempt
 * ---------------------------------------------------------------------
 * Same reasoning as register-student.ts's `registerStudent`: once one
 * statement inside a Postgres transaction fails (a unique-violation on
 * `(academy_id, receipt_number)`), the whole transaction is aborted for
 * every subsequent statement, even ones that would otherwise succeed. Each
 * attempt below therefore opens its own `db.transaction`; a losing race
 * rolls back cleanly and the next attempt's fresh `generateReceiptNumber`
 * read sees the winning attempt's committed row.
 */
export async function issueReceipt(
  actorContext: AuthContext,
  studentPaymentId: string,
  input: IssueReceiptInput = {},
): Promise<IssueReceiptResult> {
  const resolved = await resolveStudentPaymentsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(studentPaymentId);
  if (!parsedId.success) {
    return { ok: false, error: PAYMENT_NOT_FOUND };
  }

  const parsedInput = issueReceiptSchema.safeParse(input);
  if (!parsedInput.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsedInput.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }
  const issuedAt = parsedInput.data.issuedAt ?? new Date();

  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt += 1) {
    try {
      const result = await db.transaction(async (tx) => {
        const [payment] = await tx
          .select()
          .from(studentPayments)
          .where(
            and(eq(studentPayments.id, studentPaymentId), eq(studentPayments.academyId, academyId)),
          )
          .for("update");
        if (!payment) {
          return { kind: "not_found" as const };
        }
        if (payment.status !== "approved") {
          return { kind: "invalid_state" as const };
        }

        const [existingReceipt] = await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(eq(receipts.studentPaymentId, studentPaymentId))
          .limit(1);
        if (existingReceipt) {
          return { kind: "already_issued" as const };
        }

        const receiptNumber = await generateReceiptNumber(tx, academyId);

        const [row] = await tx
          .insert(receipts)
          .values({
            academyId,
            studentPaymentId,
            receiptNumber,
            issuedAt,
            issuedBy: actorContext.userId,
          })
          .returning();

        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: membershipRole,
            academyId,
            action: "issueReceipt",
            entityType: "receipt",
            entityId: row.id,
            after: toReceiptRecord(row),
          },
          tx,
        );

        return { kind: "ok" as const, row };
      });

      if (result.kind === "not_found") {
        return { ok: false, error: PAYMENT_NOT_FOUND };
      }
      if (result.kind === "invalid_state") {
        return {
          ok: false,
          error: {
            code: "invalid_state",
            message: "A receipt can only be issued for an approved payment.",
          },
        };
      }
      if (result.kind === "already_issued") {
        return {
          ok: false,
          error: { code: "conflict", message: "A receipt has already been issued for this payment." },
        };
      }

      // Item 58b — `payment.receipt_issued` notification. Recipient:
      // `actorContext.userId` (whoever issued the receipt) — students carry
      // no `user_id`/login in this system (see lib/db/schema.ts's `students`
      // table), so "the payer" is never a resolvable platform user; the
      // issuing staff member is the only real recipient available. Called
      // with the default `db` client, after this attempt's transaction has
      // already committed (this line only runs once `result.kind === "ok"`)
      // — see lib/academies/approval-requests.ts's module comment ("Why
      // enqueueNotification is called with the default db client") for why
      // a notification failure must never be allowed to affect the
      // already-committed business outcome.
      try {
        await enqueueNotification({
          eventType: "payment.receipt_issued",
          entityId: result.row.id,
          templateId: "payment.receipt_issued",
          academyId,
          userId: actorContext.userId,
        });
      } catch (err) {
        logger.error("Failed to enqueue payment.receipt_issued notification", {
          receiptId: result.row.id,
          academyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return { ok: true, receipt: toReceiptRecord(result.row) };
    } catch (err) {
      if (isUniqueViolation(err)) {
        continue; // fresh transaction, fresh candidate, next attempt
      }
      throw err;
    }
  }

  throw new Error("issueReceipt: exhausted retry attempts generating a unique receipt number.");
}

/** Shared by `approveStudentPayment`/`rejectStudentPayment`: the one
 * `pending` `approval_requests` row for this student payment, if any — same
 * defensive "treat a missing row as invalid_state, not not_found" convention
 * as lib/academies/expense-records.ts's `findPendingApprovalRequest`. Reads
 * through the same transaction executor as the caller so it observes the
 * row created (or not) inside that same transaction. */
async function findPendingStudentPaymentApprovalRequest(tx: DbClient, studentPaymentId: string) {
  const [pending] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.entityType, "student_payment"),
        eq(approvalRequests.entityId, studentPaymentId),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);
  return pending ?? null;
}

/** Maps decideApprovalRequest's own error shape onto this file's error type
 * — same convention as lib/academies/expense-records.ts's
 * `mapDecisionError`. */
function mapDecisionError(error: { code: string; message: string }): StudentPaymentsActionError {
  if (error.code === "self_approval" || error.code === "already_decided") {
    return { code: error.code, message: error.message };
  }
  return { code: "validation", message: error.message };
}

function alreadyProcessedError(status: string, verb: "approved" | "rejected"): StudentPaymentsActionError {
  return {
    code: "already_processed",
    message: `This payment has already been ${status} — it can no longer be ${verb}.`,
  };
}

/**
 * PLAN.md's Finance Lifecycle table, `student_charges` row: "`partially_paid`
 * / `paid` (derived automatically, not a manual transition ...) — see
 * status-derivation note below," and elsewhere: "Whenever a `student_payments`
 * row referencing this charge is approved..., the charge's paid-to-date
 * total is recalculated inside that same approval transaction." This is
 * that recalculation, called from `approveStudentPayment` below AND —
 * confirmed Phase 4 post-implementation audit gap fix — from
 * `lib/academies/finance-reversals.ts`'s `reverseStudentPayment`/
 * `adjustStudentPayment` once a charge-linked payment's status stops being
 * `"approved"`. A rejected payment was never counted in the first place
 * (`rejectStudentPayment` still doesn't call this — nothing changes for it
 * to recalculate), but a *reversed* payment WAS counted and must be
 * removed from the charge's paid total, which only happens by re-running
 * this same live re-`SUM`. Exported (not file-local) specifically so that
 * caller can reuse it rather than duplicating the recalculation logic.
 *
 * ---------------------------------------------------------------------
 * Why the fix lives here as an export, not as new logic in
 * finance-reversals.ts
 * ---------------------------------------------------------------------
 * This function's status-derivation rule, race-safety (row lock), and
 * "leave a cancelled charge alone" exception are all specific to
 * `student_charges` and already fully correct — duplicating any of that
 * in finance-reversals.ts would risk the two copies drifting apart. The
 * only thing finance-reversals.ts needs is "recalculate this charge, from
 * inside my own transaction, after this reversal/adjustment" — exactly
 * this function's existing signature.
 *
 * Race-safety: locks the `student_charges` row (`SELECT ... FOR UPDATE`)
 * inside the SAME transaction as `approveStudentPayment`'s own payment-row
 * lock, before computing the new total — this serializes two concurrent
 * approvals of two *different* payments linked to the *same* charge, so
 * neither can read a stale paid-total and overwrite the other's effect
 * (the classic lost-update race a naive "read total, then write status"
 * without a row lock would allow).
 *
 * Status derivation, per the exact rule given in this fix's own
 * requirements (matching PLAN.md's `open`/`partially_paid`/`paid` intent):
 * paidTotal <= 0 -> "open"; 0 < paidTotal < charge.amountCents ->
 * "partially_paid"; paidTotal >= charge.amountCents -> "paid". Only
 * `status = "approved"` student_payments rows are ever summed — pending
 * and rejected rows never contribute, matching the requirement that they
 * must not count toward the charge's paid amount.
 *
 * A charge already `"cancelled"` (a separate, later action — not built by
 * any item in this phase) is deliberately left untouched: PLAN.md's own
 * Finance Lifecycle table describes `cancelled` as reachable "only from
 * `open` or `partially_paid`, never from `paid`," implying it is a
 * terminal state a later payment approval must not silently revive out of
 * — recalculating a cancelled charge back to `open`/`partially_paid`/`paid`
 * would contradict that. This is a judgment call, since no item in this
 * phase actually builds `cancelChargeAction` yet.
 */
export async function recalculateStudentChargeStatus(
  tx: DbClient,
  chargeId: string,
  actorUserId: string,
  actorRole: AcademyRole,
): Promise<void> {
  const [charge] = await tx
    .select()
    .from(studentCharges)
    .where(eq(studentCharges.id, chargeId))
    .for("update");
  if (!charge || charge.status === "cancelled") return;

  const [sumRow] = await tx
    .select({ total: sql<string>`coalesce(sum(${studentPayments.amountCents}), 0)` })
    .from(studentPayments)
    .where(and(eq(studentPayments.chargeId, chargeId), eq(studentPayments.status, "approved")));
  const paidTotal = Number(sumRow?.total ?? 0);

  const nextStatus: StudentChargeRecord["status"] =
    paidTotal <= 0 ? "open" : paidTotal < charge.amountCents ? "partially_paid" : "paid";

  if (nextStatus === charge.status) return;

  const [updated] = await tx
    .update(studentCharges)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(studentCharges.id, chargeId))
    .returning();

  await recordAudit(
    {
      actorUserId,
      actorRole,
      academyId: charge.academyId,
      action: "recalculateStudentChargeStatus",
      entityType: "student_charge",
      entityId: chargeId,
      before: { status: charge.status },
      after: { status: updated.status, paidTotalCents: paidTotal },
    },
    tx,
  );
}

export type ApproveStudentPaymentResult =
  | { ok: true; payment: StudentPaymentRecord }
  | { ok: false; error: StudentPaymentsActionError };

/**
 * PLAN.md Phase 4, Item 52 — `approveStudentPayment`. Finance Lifecycle
 * table: `pending_approval -> approved`, actor Manager only (`canApprove`'s
 * `level === "full"` gate — Owner/Admin are View-only, Finance Officer never
 * reaches approve authority on this row even for someone else's
 * submission). Delegates the actual decision — including the universal
 * self-approval block and one-shot-decision guard — to Item 50a's
 * `decideApprovalRequest`; this function's own added value is the row lock
 * (PLAN.md's Concurrency & Idempotency table: "Payment verification
 * (verifySubscriptionPayment, approveStudentPayment) — row-locked status
 * check — two concurrent calls on the same row: one succeeds, one gets a
 * clear 'already processed' error" — same `SELECT ... FOR UPDATE` + status
 * check shape as lib/subscriptions/payments.ts's
 * `verifySubscriptionPayment`), resolving which pending `approval_requests`
 * row belongs to this payment, flipping the payment's own
 * `status`/`approved_by`/`approved_at`, and — when the payment is linked to
 * a charge — recalculating that charge's `status` (see
 * `recalculateStudentChargeStatus` above), all in the same transaction as
 * that decision.
 */
export async function approveStudentPayment(
  actorContext: AuthContext,
  studentPaymentId: string,
): Promise<ApproveStudentPaymentResult> {
  const resolved = await resolveStudentPaymentsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canApprove(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(studentPaymentId);
  if (!parsedId.success) {
    return { ok: false, error: PAYMENT_NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(studentPayments)
      .where(and(eq(studentPayments.id, studentPaymentId), eq(studentPayments.academyId, academyId)))
      .for("update");
    if (!payment) {
      return { kind: "not_found" as const };
    }
    if (payment.status !== "pending_approval") {
      return { kind: "already_processed" as const, status: payment.status };
    }

    const pending = await findPendingStudentPaymentApprovalRequest(tx, studentPaymentId);
    if (!pending) {
      // Unreachable in practice — recordStudentPayment always creates this
      // row alongside the payment in the same transaction (Item 52's own
      // gap fix, above).
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
      .update(studentPayments)
      .set({ status: "approved", approvedBy: actorContext.userId, approvedAt: new Date() })
      .where(eq(studentPayments.id, studentPaymentId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "approveStudentPayment",
        entityType: "student_payment",
        entityId: studentPaymentId,
        before: { status: payment.status },
        after: { status: updated.status, approvedBy: updated.approvedBy, approvedAt: updated.approvedAt },
      },
      tx,
    );

    // Requirement gap fix: recalculate the linked charge's status (if any)
    // in the SAME transaction as this approval — see
    // recalculateStudentChargeStatus's own module comment for the full
    // rule and race-safety reasoning.
    if (updated.chargeId) {
      await recalculateStudentChargeStatus(tx, updated.chargeId, actorContext.userId, membershipRole);
    }

    return { kind: "ok" as const, row: updated };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: PAYMENT_NOT_FOUND };
  }
  if (result.kind === "already_processed") {
    return { ok: false, error: alreadyProcessedError(result.status, "approved") };
  }
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "No pending approval request found for this payment." },
    };
  }
  if (result.kind === "decision_error") {
    return { ok: false, error: mapDecisionError(result.error) };
  }
  return { ok: true, payment: toPaymentRecord(result.row) };
}

export type RejectStudentPaymentResult =
  | { ok: true; payment: StudentPaymentRecord }
  | { ok: false; error: StudentPaymentsActionError };

/**
 * PLAN.md Phase 4, Item 52 — `rejectStudentPayment`. Finance Lifecycle
 * table: `pending_approval -> rejected`, "reason required", same approval
 * authority as `approveStudentPayment`. Same row-lock/`decideApprovalRequest`
 * delegation, plus persisting the required reason onto the
 * `approval_requests` row (there is no `rejection_reason` column on
 * `student_payments` itself — see lib/db/schema.ts's column list; only
 * `reversal_reason`, for Item 54 — so this follows the same convention as
 * this codebase's `rejectGradeConfig` rather than `rejectExpense`'s
 * additional own-table column write).
 */
export async function rejectStudentPayment(
  actorContext: AuthContext,
  studentPaymentId: string,
  reason: string,
): Promise<RejectStudentPaymentResult> {
  const resolved = await resolveStudentPaymentsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canApprove(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(studentPaymentId);
  if (!parsedId.success) {
    return { ok: false, error: PAYMENT_NOT_FOUND };
  }

  const parsedReason = rejectStudentPaymentReasonSchema.safeParse(reason);
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
    const [payment] = await tx
      .select()
      .from(studentPayments)
      .where(and(eq(studentPayments.id, studentPaymentId), eq(studentPayments.academyId, academyId)))
      .for("update");
    if (!payment) {
      return { kind: "not_found" as const };
    }
    if (payment.status !== "pending_approval") {
      return { kind: "already_processed" as const, status: payment.status };
    }

    const pending = await findPendingStudentPaymentApprovalRequest(tx, studentPaymentId);
    if (!pending) {
      // Unreachable in practice — same reasoning as approveStudentPayment's
      // identical defensive branch above.
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
      .update(studentPayments)
      .set({ status: "rejected" })
      .where(eq(studentPayments.id, studentPaymentId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "rejectStudentPayment",
        entityType: "student_payment",
        entityId: studentPaymentId,
        before: { status: payment.status },
        after: { status: updated.status, rejectionReason: parsedReason.data },
      },
      tx,
    );

    return { kind: "ok" as const, row: updated };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: PAYMENT_NOT_FOUND };
  }
  if (result.kind === "already_processed") {
    return { ok: false, error: alreadyProcessedError(result.status, "rejected") };
  }
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "No pending approval request found for this payment." },
    };
  }
  if (result.kind === "decision_error") {
    return { ok: false, error: mapDecisionError(result.error) };
  }
  return { ok: true, payment: toPaymentRecord(result.row) };
}
