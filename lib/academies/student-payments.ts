import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  academies,
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
import { enqueueNotification } from "@/lib/notifications/notifications";
import { logger } from "@/lib/logger";

/**
 * PLAN.md Phase 4, Item 51 — "createStudentCharge, recordStudentPayment,
 * issueReceipt."
 *
 * ---------------------------------------------------------------------
 * No approval workflow — student payments are immediately effective
 * ---------------------------------------------------------------------
 * Item 52's original `approveStudentPayment`/`rejectStudentPayment` (and
 * the `pending_approval -> approved/rejected` step they mediated via
 * `approval_requests`) have been removed entirely, per an explicit later
 * architecture decision: recording a student payment (recurring
 * fee-period payment OR one-off charge payment) now writes `status:
 * "approved"` directly, with `approvedBy`/`approvedAt` set to the
 * recording user at record time. There is no "pending" state a normal
 * student payment ever passes through anymore, no separate decision step,
 * and no self-approval concept to gate (nothing is ever decided by anyone
 * other than the recorder, because nothing is ever decided at all).
 *
 * This does NOT affect the shared `approval_requests` table itself, which
 * other entities (grade configurations, expenses) still use unmodified —
 * this file simply stopped being one of its consumers. `student_payments`
 * rows that were already `pending_approval`/`rejected` from before this
 * change remain in the database untouched (historical data is never
 * rewritten); they just have no further code path that can ever act on
 * them again (the same terminal-state guarantee any `rejected`/`reversed`
 * row already has).
 *
 * The one remaining "decision" a student payment can go through post-hoc
 * is a correction — `reverseStudentPayment`/`adjustStudentPayment`
 * (lib/academies/finance-reversals.ts) — which was ALREADY fully
 * independent of `approval_requests` (it does its own direct
 * `recordedBy === actorContext.userId` self-check, never
 * `decideApprovalRequest`), so it needed no change at all for this.
 *
 * ---------------------------------------------------------------------
 * Permission gating
 * ---------------------------------------------------------------------
 * lib/auth/academy-permissions.ts's `ACADEMY_STUDENT_PAYMENTS_ACTION` row:
 * Owner/Trainer = "view", Manager = "full", Finance Officer/Academy
 * Administrator = "manage", Admissions Officer = no entry ("none").
 * (Academy Administrator was raised from "view" to "manage" per the Afoogy
 * manual student-payment verification report's staff list — see that
 * permission row's own comment.) `canManage`'s "full"-or-"manage" gate below
 * is the ONE authority this file now checks for every mutation (create
 * charge / record payment / issue receipt): Manager, Finance Officer, and
 * Academy Administrator may all do all three, immediately, with no second,
 * stricter "approve" gate above it anymore — this is what fixes the
 * previous asymmetry where Finance Officer could record a payment but never
 * get it approved without a Manager's separate action. Owner/Trainer
 * (view-only) are refused on every mutation in this file.
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

/** Same gate `reverseStudentPayment`/`adjustStudentPayment`
 * (lib/academies/finance-reversals.ts) requires — Manager only. Exposed
 * from `listStudentPayments` below purely so the UI knows whether to
 * render Reverse/Adjust controls, without re-deriving the permission level
 * itself (this is NOT an approval gate — there is no approval anymore). */
function canReverse(level: AcademyPermissionLevel): boolean {
  return level === "full";
}

export interface StudentPaymentsActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict" | "invalid_state";
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
  // Distinct from `reference` (a transaction/reference number) — free-form
  // staff notes, e.g. "Second installment".
  notes: optionalText(1000),
  receivedAt: z.coerce.date({ message: "A valid received date is required" }),
});

export type RecordStudentPaymentInput = z.input<typeof recordStudentPaymentSchema>;

export const issueReceiptSchema = z.object({
  issuedAt: z.coerce.date().optional(),
});

export type IssueReceiptInput = z.input<typeof issueReceiptSchema>;

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
  notes: string | null;
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
    notes: row.notes,
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
      /** Whether this caller can reverse/adjust a payment — `canReverse`'s
       * stricter "full" (Manager)-only gate, distinct from `canManage`'s
       * "full"-or-"manage" (also Finance Officer). There is no approval
       * step anymore; this flag exists purely so the UI knows whether to
       * render Reverse/Adjust controls. */
      canReverse: boolean;
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
    canReverse: canReverse(permissionLevel),
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

/** Batched "does this payment have a receipt" lookup — one query for many
 * payment ids, never one per row, for the student detail page's payment
 * history table (each row needs to know whether to show a receipt link).
 * Tenant-scoped the same way every other read in this file is. */
export async function listReceiptsForPayments(
  actorContext: AuthContext,
  studentPaymentIds: string[],
): Promise<Map<string, ReceiptRecord>> {
  const result = new Map<string, ReceiptRecord>();
  if (studentPaymentIds.length === 0) return result;

  const resolved = await resolveStudentPaymentsAccess(actorContext);
  if (!resolved.ok) return result;
  const { academyId } = resolved.access;

  const rows = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.academyId, academyId), inArray(receipts.studentPaymentId, studentPaymentIds)));

  for (const row of rows) {
    result.set(row.studentPaymentId, toReceiptRecord(row));
  }
  return result;
}

export type CreateStudentChargeResult =
  | { ok: true; charge: StudentChargeRecord }
  | { ok: false; error: StudentPaymentsActionError };

/**
 * PLAN.md §4/Finance Lifecycle: `createStudentCharge` — always starts
 * `open` (the table's own DB default), created by Manager, Finance
 * Officer, or Academy Administrator, no approval step. Only `canManage`
 * (Manager="full", Finance Officer/Academy Administrator="manage") may
 * call this — Owner/Trainer (view-only) are refused.
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
 * PLAN.md §4/Finance Lifecycle, as amended by the later "no approval
 * workflow for student payments" architecture decision: `recordStudentPayment`
 * now writes `status: "approved"` (with `approvedBy`/`approvedAt` set to the
 * recording user) directly — the payment is immediately effective, counts
 * toward the linked charge's balance (if any) in this same transaction, and
 * is immediately eligible for a receipt. Same `canManage` gate as
 * `createStudentCharge` — Manager, Finance Officer, or Academy
 * Administrator, no separate/stricter approval authority required.
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
    const now = new Date();

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
        notes: data.notes,
        receivedAt: data.receivedAt,
        recordedBy: actorContext.userId,
        status: "approved",
        approvedBy: actorContext.userId,
        approvedAt: now,
      })
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "recordStudentPayment",
        entityType: "student_payment",
        entityId: row.id,
        after: toPaymentRecord(row),
      },
      tx,
    );

    // Immediately effective — no approval step to defer this to anymore.
    // Same recalculation `approveStudentPayment` used to perform, just run
    // in the same transaction as the insert instead of a later decision.
    if (row.chargeId) {
      await recalculateStudentChargeStatus(tx, row.chargeId, actorContext.userId, membershipRole);
    }

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

/**
 * PLAN.md's Finance Lifecycle table, `student_charges` row: "`partially_paid`
 * / `paid` (derived automatically, not a manual transition ...)." Whenever a
 * `student_payments` row referencing this charge becomes (or stops being)
 * `"approved"`, the charge's paid-to-date total is recalculated inside that
 * same transaction. Called from `recordStudentPayment` above (a new
 * charge-linked payment is `"approved"` immediately, no separate approval
 * step anymore) and from `lib/academies/finance-reversals.ts`'s
 * `reverseStudentPayment`/`adjustStudentPayment` once a charge-linked
 * payment's status stops being `"approved"`. Exported (not file-local) so
 * both callers reuse the exact same recalculation rather than duplicating
 * it.
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
 * inside the SAME transaction as the payment insert/reversal, before
 * computing the new total — this serializes two concurrent
 * payments/reversals against the *same* charge, so neither can read a
 * stale paid-total and overwrite the other's effect (the classic
 * lost-update race a naive "read total, then write status" without a row
 * lock would allow).
 *
 * Status derivation: paidTotal <= 0 -> "open"; 0 < paidTotal <
 * charge.amountCents -> "partially_paid"; paidTotal >= charge.amountCents
 * -> "paid". Only `status = "approved"` student_payments rows are ever
 * summed — rejected/reversed rows never contribute, matching the
 * requirement that they must not count toward the charge's paid amount.
 *
 * A charge already `"cancelled"` is deliberately left untouched: PLAN.md's
 * own Finance Lifecycle table describes `cancelled` as reachable "only
 * from `open` or `partially_paid`, never from `paid`," implying it is a
 * terminal state a later payment must not silently revive out of.
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

