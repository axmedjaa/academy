import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { approvalRequests } from "@/lib/db/schema";

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

  return { ok: true, request: toRecord(row) };
}

const decideApprovalRequestInputSchema = z.object({
  decidedBy: z.string().uuid("Invalid decider id"),
  status: z.enum(["approved", "rejected"]),
});

export type DecideApprovalRequestInput = z.input<typeof decideApprovalRequestInputSchema>;

export type DecideApprovalRequestResult =
  | { ok: true; request: ApprovalRequestRecord }
  | { ok: false; error: ApprovalRequestError };

/**
 * PLAN.md/DESIGN.md §11.4's universal self-approval rule, encoded once
 * here: `requestedBy === decidedBy` is refused unconditionally, regardless
 * of entity type, before any DB write. Also enforces the table's own
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

  if (existing.requestedBy === data.decidedBy) {
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
): Promise<ApprovalRequestRecord[]> {
  const parsedAcademyId = z.string().uuid().safeParse(academyId);
  if (!parsedAcademyId.success) {
    return [];
  }

  const conditions = [eq(approvalRequests.academyId, academyId), eq(approvalRequests.status, "pending")];
  if (entityType) {
    conditions.push(eq(approvalRequests.entityType, entityType));
  }

  const rows = await executor
    .select()
    .from(approvalRequests)
    .where(and(...conditions));

  return rows.map(toRecord);
}
