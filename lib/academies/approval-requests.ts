import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { approvalRequests, batches, examResults, expenseRecords, studentPayments } from "@/lib/db/schema";
import { studentInScopeCondition, type BranchScope } from "@/lib/academies/branch-access";
import { enqueueNotification } from "@/lib/notifications/notifications";
import type { NotificationTemplateId } from "@/lib/notifications/templates";
import { logger } from "@/lib/logger";

/**
 * PLAN.md Phase 3, Item 50a — "`approval_requests` ONLY (not
 * `result_corrections` — a separate, later item)."
 *
 * ---------------------------------------------------------------------
 * What this module is (and isn't)
 * ---------------------------------------------------------------------
 * Cross-Cutting Architecture Decisions: "single reusable `approval_requests`
 * table, introduced in Phase 3 (results/grades) and reused in Phase 4
 * (finance)." This module is the generic, reusable mechanism every future
 * consumer calls into — `createApprovalRequest`, `decideApprovalRequest`,
 * `listPendingApprovalRequests` — plus the one rule DESIGN.md §11.4
 * describes as universal across every entity type that uses this table
 * (the submitter can never be the decider), encoded once here rather than
 * duplicated in every future consumer.
 *
 * It is deliberately NOT `approveResult`/`approveGradeConfig`/any other
 * entity-specific action — those belong to separate, later items (the
 * result-approval workflow and the grade-configuration approval flow) that
 * don't exist yet and will call into this module rather than reimplement
 * it. This module also adds nothing to lib/auth/academy-permissions.ts:
 * `approval_requests` has no gating capability of its own (per this item's
 * brief) — each future consumer gates through its own permission row
 * before ever calling `createApprovalRequest`/`decideApprovalRequest`.
 *
 * `entityId` is intentionally a bare, unchecked uuid — there is no FK to
 * validate it against (see lib/db/schema.ts's comment on `approvalRequests`
 * for why: it points at a different table depending on `entityType`). This
 * module has no way to confirm the referenced entity exists or that
 * `entityType` matches what it actually is — that responsibility belongs
 * to the caller (a future `approveResult`/`approveGradeConfig`), which
 * already holds a real, type-checked reference to the row it's requesting
 * approval for.
 */
export const APPROVAL_REQUEST_ENTITY_TYPES = [
  "result",
  "grade_configuration",
  "expense",
  "student_payment",
] as const;
export type ApprovalRequestEntityType = (typeof APPROVAL_REQUEST_ENTITY_TYPES)[number];

export const APPROVAL_REQUEST_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

/**
 * PLAN.md Phase 5, Item 58b — wiring `enqueueNotification` into this
 * module's two generic mutators, on behalf of every one of its four
 * consumers (results, grade configuration, expenses, student payments) at
 * once, rather than duplicating the same enqueue call in each of their own
 * files.
 *
 * ---------------------------------------------------------------------
 * Template bucket per entity type
 * ---------------------------------------------------------------------
 * PLAN.md's notification event catalog (lib/notifications/templates.ts)
 * has exactly two approval-flavored buckets — "result.*" and "finance.*" —
 * and no distinct "grade configuration approval" event of its own. Grade
 * bands are part of the academic/results domain (the same judgment call
 * lib/auth/academy-permissions.ts's own `ACADEMY_GRADE_BANDS_ACTION`
 * comment already makes when it discusses that row alongside
 * `ACADEMY_RESULTS_ACTION`), so "result" and "grade_configuration" both map
 * to "result.*", and "expense"/"student_payment" both map to "finance.*".
 * Documented here, once, since PLAN.md never states it verbatim.
 *
 * ---------------------------------------------------------------------
 * Recipient resolution — the real ambiguity, resolved two different ways
 * ---------------------------------------------------------------------
 * `createApprovalRequest` (a NEW pending request, notifying whoever could
 * decide it): this module is deliberately entity-type-agnostic and has "no
 * gating capability of its own" (see this file's own module comment) — each
 * of the four consumers holds its own distinct permission row
 * (`ACADEMY_RESULTS_ACTION`/`ACADEMY_GRADE_BANDS_ACTION`/
 * `ACADEMY_EXPENSES_ACTION`/`ACADEMY_STUDENT_PAYMENTS_ACTION`) and its own
 * distinct "approve" predicate (some use `level === "approve"`, some
 * `level === "full"` — see each consumer file's own `canApprove`). Reaching
 * into all four of those permission rows from this generic module, just to
 * resolve a notification recipient, would break the exact separation of
 * concerns this module's own module comment insists on ("adds nothing to
 * lib/auth/academy-permissions.ts... each future consumer gates through its
 * own permission row"). So this deliberately takes PLAN.md's brief's
 * documented simpler alternative: `userId: null`, `academyId` set — an
 * academy-scoped notification every member of the academy's decision queue
 * can see (Item 59's later UI filters by academy membership), rather than a
 * fragile, per-entity-type permission lookup duplicated into a module that
 * otherwise knows nothing about permissions at all.
 *
 * `decideApprovalRequest` (a request being approved/rejected, notifying the
 * original submitter): unambiguous — the request's own `requestedBy`
 * column, already on hand, no permission lookup needed.
 *
 * ---------------------------------------------------------------------
 * Why `enqueueNotification` is called with the default `db` client, never
 * with `executor`
 * ---------------------------------------------------------------------
 * Both functions accept an `executor` that may be a caller's own open
 * `db.transaction()` (e.g. `submitResults`, `recordStudentPayment`,
 * `approveResult`, `approveStudentPayment` all call in from inside one).
 * Postgres aborts an ENTIRE transaction after any statement inside it
 * errors — a JS `try/catch` around `enqueueNotification` can swallow the
 * thrown error, but it cannot un-poison that transaction: the caller's very
 * next statement on that same `tx` would then fail with an unrelated
 * "current transaction is aborted" error, which is exactly the "must NEVER
 * cause the underlying business action to fail or roll back" outcome this
 * item's brief forbids. Calling `enqueueNotification` with the default `db`
 * client instead runs it on its own separate connection, so any failure
 * inside it — a bug, a transient DB error, anything not already handled by
 * `enqueueNotification`'s own internal unique-violation handling — can
 * never poison the caller's transaction, no matter when it's called
 * relative to that transaction's commit.
 *
 * Trade-off, documented rather than silently accepted: because this runs
 * before the caller's own transaction necessarily commits, a notification
 * can in principle be created for an approval-request row that a *later*
 * statement in that same caller transaction still causes to roll back
 * (nothing in this module controls when the caller commits). This is
 * judged strictly preferable to the alternative (poisoning real business
 * transactions on any notification hiccup) — `entityId` here is never a
 * foreign key, so a stray notification referencing a since-rolled-back id
 * is inert, not a referential-integrity problem.
 */
function notificationBucketForEntityType(
  entityType: ApprovalRequestEntityType,
): "result" | "finance" {
  return entityType === "result" || entityType === "grade_configuration" ? "result" : "finance";
}

export interface ApprovalRequestRecord {
  id: string;
  academyId: string;
  entityType: ApprovalRequestEntityType;
  entityId: string;
  requestedBy: string;
  status: ApprovalRequestStatus;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

function toRecord(row: typeof approvalRequests.$inferSelect): ApprovalRequestRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    entityType: row.entityType,
    entityId: row.entityId,
    requestedBy: row.requestedBy,
    status: row.status,
    reason: row.reason,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

export interface ApprovalRequestError {
  code: "validation" | "not_found" | "self_approval" | "already_decided";
  message: string;
}

const createApprovalRequestInputSchema = z.object({
  academyId: z.string().uuid("Invalid academy id"),
  entityType: z.enum(APPROVAL_REQUEST_ENTITY_TYPES),
  entityId: z.string().uuid("Invalid entity id"),
  requestedBy: z.string().uuid("Invalid requester id"),
  reason: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

export type CreateApprovalRequestInput = z.input<typeof createApprovalRequestInputSchema>;

export type CreateApprovalRequestResult =
  | { ok: true; request: ApprovalRequestRecord }
  | { ok: false; error: ApprovalRequestError };

/**
 * Creates a new `pending` approval request. Purely additive/generic — no
 * permission check, no existence check on the polymorphic `entityId` (see
 * module comment above for why): the caller is expected to have already
 * verified both before calling this.
 */
export async function createApprovalRequest(
  executor: DbClient = db,
  input: CreateApprovalRequestInput,
): Promise<CreateApprovalRequestResult> {
  const parsed = createApprovalRequestInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const [row] = await executor
    .insert(approvalRequests)
    .values({
      academyId: data.academyId,
      entityType: data.entityType,
      entityId: data.entityId,
      requestedBy: data.requestedBy,
      reason: data.reason,
    })
    .returning();

  await enqueueApprovalRequestedNotification(row);

  return { ok: true, request: toRecord(row) };
}

/**
 * Item 58b — non-critical side effect; never allowed to fail the caller.
 * See the module comment above ("Why enqueueNotification is called with the
 * default db client") for why `db`, not `executor`, is used here.
 */
async function enqueueApprovalRequestedNotification(row: typeof approvalRequests.$inferSelect): Promise<void> {
  try {
    const bucket = notificationBucketForEntityType(row.entityType);
    const templateId: NotificationTemplateId =
      bucket === "result" ? "result.approval_requested" : "finance.approval_requested";
    await enqueueNotification({
      eventType: `${row.entityType}.approval_requested`,
      entityId: row.id,
      templateId,
      academyId: row.academyId,
      userId: null,
    });
  } catch (err) {
    logger.error("Failed to enqueue approval_requested notification", {
      approvalRequestId: row.id,
      entityType: row.entityType,
      academyId: row.academyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** How many approval_requested notifications are enqueued at once by the
 * bulk variant below — enough to overlap their round trips, small enough to
 * leave the shared connection pool (lib/db, `max: 10`) for other requests. */
const BULK_NOTIFICATION_CONCURRENCY = 4;

export type CreateApprovalRequestsResult =
  | { ok: true; requests: ApprovalRequestRecord[] }
  | { ok: false; error: ApprovalRequestError };

/**
 * Performance plan P8: `createApprovalRequest` for many entities at once —
 * one multi-row INSERT instead of one per entity. Every input is validated
 * with the same schema first (nothing is inserted if any is invalid), each
 * row gets the same approval_requested notification with the same
 * idempotency key, and the result lists the requests in input order.
 */
export async function createApprovalRequests(
  executor: DbClient,
  inputs: CreateApprovalRequestInput[],
): Promise<CreateApprovalRequestsResult> {
  const parsedInputs = [];
  for (const input of inputs) {
    const parsed = createApprovalRequestInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      };
    }
    parsedInputs.push(parsed.data);
  }
  if (parsedInputs.length === 0) return { ok: true, requests: [] };

  const inserted = await executor
    .insert(approvalRequests)
    .values(
      parsedInputs.map((data) => ({
        academyId: data.academyId,
        entityType: data.entityType,
        entityId: data.entityId,
        requestedBy: data.requestedBy,
        reason: data.reason,
      })),
    )
    .returning();
  // RETURNING order is not guaranteed by SQL; restore input order by entity.
  const byEntity = new Map(inserted.map((row) => [`${row.entityType}:${row.entityId}`, row]));
  const rows = parsedInputs.map((data) => byEntity.get(`${data.entityType}:${data.entityId}`)!);

  for (let i = 0; i < rows.length; i += BULK_NOTIFICATION_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + BULK_NOTIFICATION_CONCURRENCY).map(enqueueApprovalRequestedNotification));
  }

  return { ok: true, requests: rows.map(toRecord) };
}

const decideApprovalRequestInputSchema = z.object({
  decidedBy: z.string().uuid("Invalid decider id"),
  status: z.enum(["approved", "rejected"]),
  /**
   * Approved architecture decision: "Manager creates/records -> Manager
   * CAN approve their own work," later generalized to "Owner/Academy
   * Administrator/Manager should never be blocked waiting for approval on
   * an action they are already authorized to perform" — computed by each
   * consumer from its OWN existing `canManage`/`canApprove`-equivalent
   * gates (see student-payments.ts's, grade-configurations.ts's,
   * results.ts's, and result-corrections.ts's own `canSelfDecide`
   * computations) — never a new permission grant, never a client-supplied
   * flag (always a boolean literal computed server-side from the actor's
   * already-resolved permission level before this function is ever
   * called).
   *
   * Defaults to `false` — `expense` (confirmed to have no realistic
   * self-approval scenario under its own permission matrix — Admin/Manager
   * only ever approve Finance Officer's submissions, never their own) keeps
   * today's unconditional self-approval block, byte for byte, with zero
   * risk of accidental loosening. `student_payment`, `grade_configuration`,
   * and `result` (reused as-is by result_corrections.ts) each opt in,
   * computing their own `canSelfDecide` from their own existing permission
   * gates — for `result`, this can never reach Trainer, since Trainer never
   * holds the `"approve"` level `canSelfDecide` checks there.
   */
  allowSelfDecision: z.boolean().default(false),
});

export type DecideApprovalRequestInput = z.input<typeof decideApprovalRequestInputSchema>;

export type DecideApprovalRequestResult =
  | { ok: true; request: ApprovalRequestRecord }
  | { ok: false; error: ApprovalRequestError };

/**
 * PLAN.md/DESIGN.md §11.4's self-approval rule, encoded once here:
 * `requestedBy === decidedBy` is refused before any DB write — UNLESS the
 * caller explicitly opts in via `input.allowSelfDecision` (see that field's
 * own doc comment on `decideApprovalRequestInputSchema` for exactly which
 * consumers opt in and why). Also enforces the table's own
 * `pending -> approved|rejected` shape as a one-shot decision: a request
 * that has already been decided (status !== "pending") cannot be decided
 * again — `already_decided`, not a silent overwrite of `decided_by`/
 * `decided_at`.
 */
export async function decideApprovalRequest(
  executor: DbClient = db,
  approvalRequestId: string,
  input: DecideApprovalRequestInput,
): Promise<DecideApprovalRequestResult> {
  const parsedId = z.string().uuid().safeParse(approvalRequestId);
  if (!parsedId.success) {
    return { ok: false, error: { code: "not_found", message: "Approval request not found." } };
  }

  const parsed = decideApprovalRequestInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const [existing] = await executor
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalRequestId))
    .limit(1);
  if (!existing) {
    return { ok: false, error: { code: "not_found", message: "Approval request not found." } };
  }

  if (existing.requestedBy === data.decidedBy && !data.allowSelfDecision) {
    return {
      ok: false,
      error: {
        code: "self_approval",
        message: "You cannot approve or reject your own submission.",
      },
    };
  }

  if (existing.status !== "pending") {
    return {
      ok: false,
      error: {
        code: "already_decided",
        message: `This approval request has already been ${existing.status}.`,
      },
    };
  }

  const [updated] = await executor
    .update(approvalRequests)
    .set({ status: data.status, decidedBy: data.decidedBy, decidedAt: new Date() })
    .where(eq(approvalRequests.id, approvalRequestId))
    .returning();

  // Item 58b — non-critical side effect; never allowed to fail this
  // function. Recipient is unambiguous: the original requester
  // (`requestedBy`). Same "default db client, not executor" reasoning as
  // createApprovalRequest above.
  try {
    const bucket = notificationBucketForEntityType(updated.entityType);
    const templateId: NotificationTemplateId =
      bucket === "result" ? "result.approval_decided" : "finance.approval_decided";
    await enqueueNotification({
      eventType: `${updated.entityType}.approval_decided`,
      entityId: updated.id,
      templateId,
      academyId: updated.academyId,
      userId: updated.requestedBy,
    });
  } catch (err) {
    logger.error("Failed to enqueue approval_decided notification", {
      approvalRequestId: updated.id,
      entityType: updated.entityType,
      academyId: updated.academyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { ok: true, request: toRecord(updated) };
}

/**
 * Pending requests for an academy, optionally filtered to one entity type
 * — the read backing a future "approval queue" list (DESIGN.md's
 * "Approval queue" component). Takes no actor/AuthContext, same
 * intentionally-bare shape as `checkAllowance` (PLAN.md's literal
 * `listPendingApprovalRequests(academyId, entityType?)` signature): the
 * caller is expected to have already gated on its own permission row and
 * to already know which academyId it's allowed to see.
 */
export async function listPendingApprovalRequests(
  academyId: string,
  entityType?: ApprovalRequestEntityType,
  executor: DbClient = db,
  /** Multi-branch: when given and not all-branch, only requests for records
   * in those branches — results (via their batch), expenses (their branch)
   * and student payments (via the student). Academy-level grade
   * configuration requests are left out for branch-limited callers. */
  scope?: BranchScope,
): Promise<ApprovalRequestRecord[]> {
  const parsedAcademyId = z.string().uuid().safeParse(academyId);
  if (!parsedAcademyId.success) {
    return [];
  }

  const conditions = [eq(approvalRequests.academyId, academyId), eq(approvalRequests.status, "pending")];
  if (entityType) {
    conditions.push(eq(approvalRequests.entityType, entityType));
  }
  if (scope && !scope.academyWide) {
    if (scope.branchIds.length === 0) return [];
    conditions.push(
      or(
        and(
          eq(approvalRequests.entityType, "result"),
          inArray(
            approvalRequests.entityId,
            db
              .select({ id: examResults.id })
              .from(examResults)
              .innerJoin(batches, eq(batches.id, examResults.batchId))
              .where(and(eq(batches.academyId, academyId), inArray(batches.branchId, scope.branchIds))),
          ),
        ),
        and(
          eq(approvalRequests.entityType, "expense"),
          inArray(
            approvalRequests.entityId,
            db
              .select({ id: expenseRecords.id })
              .from(expenseRecords)
              .where(and(eq(expenseRecords.academyId, academyId), inArray(expenseRecords.branchId, scope.branchIds))),
          ),
        ),
        and(
          eq(approvalRequests.entityType, "student_payment"),
          inArray(
            approvalRequests.entityId,
            db
              .select({ id: studentPayments.id })
              .from(studentPayments)
              .where(and(eq(studentPayments.academyId, academyId), studentInScopeCondition(scope, academyId, studentPayments.studentId) ?? sql`true`)),
          ),
        ),
      )!,
    );
  }

  const rows = await executor
    .select()
    .from(approvalRequests)
    .where(and(...conditions));

  return rows.map(toRecord);
}
