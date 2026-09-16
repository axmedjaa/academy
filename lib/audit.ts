import { db, type DbClient } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { redact } from "@/lib/redact";

export interface RecordAuditInput {
  actorUserId?: string;
  actorRole?: string;
  academyId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  branchId?: string;
  before?: unknown;
  after?: unknown;
  context?: unknown;
  reason?: string;
  requestId?: string;
  result?: "success" | "failure";
  failureReason?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * The one helper every sensitive action writes its audit row through
 * (Cross-Cutting Architecture Decisions). Pass the transaction client (not
 * the global `db`) when this call must succeed-or-fail atomically with the
 * mutation it protects — PLAN.md: "the audit write happens in the same
 * database transaction as the mutation it protects." `executor` defaults
 * to `db` for standalone audit events with no surrounding mutation.
 *
 * before/after/context are redacted with the same rule as the structured
 * logger (lib/redact.ts) — never passwords, tokens, hashes, or MFA secrets.
 */
export async function recordAudit(
  input: RecordAuditInput,
  executor: DbClient = db,
): Promise<void> {
  await executor.insert(auditLogs).values({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    academyId: input.academyId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    branchId: input.branchId,
    before: input.before !== undefined ? redact(input.before) : undefined,
    after: input.after !== undefined ? redact(input.after) : undefined,
    context: input.context !== undefined ? redact(input.context) : undefined,
    reason: input.reason,
    requestId: input.requestId,
    result: input.result ?? "success",
    failureReason: input.failureReason,
    ip: input.ip,
    userAgent: input.userAgent,
  });
}
