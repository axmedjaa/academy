import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { academies, incomeRecords } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_INCOME_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 4, Item 53 — `createIncomeRecord`/`listIncomeRecords`.
 *
 * ---------------------------------------------------------------------
 * Scope: no submit/approve/reject action exists for income — deliberately
 * ---------------------------------------------------------------------
 * lib/auth/academy-permissions.ts's `ACADEMY_INCOME_ACTION` row comment
 * documents this as a confirmed, pre-resolved decision (this item's brief's
 * "decision B"): the `income_records.status` enum is only
 * `(posted, reversed)` — no `pending_approval` state exists anywhere in the
 * schema for this table (unlike `expense_records`'s five-state enum), and
 * PLAN.md's §4 action list names no `submitIncomeForApproval`/
 * `approveIncome`/`rejectIncome` anywhere. `createIncomeRecord` therefore
 * always writes `status: "posted"` directly, in one step, with no
 * intermediate state ever reachable — this file exports no other mutation
 * besides that one and the read-only `listIncomeRecords`. `reversed` is
 * Item 54's job (reverseTransaction/adjustTransaction), not built here.
 *
 * ---------------------------------------------------------------------
 * Permission gating
 * ---------------------------------------------------------------------
 * `ACADEMY_INCOME_ACTION`: Owner/Admin/Manager = "view", Finance Officer =
 * "manage", Admissions Officer/Trainer = no entry ("none"). Only "manage"
 * (Finance Officer) may create — this is a plain equality check, not a
 * `canManage`-style "full-or-manage" gate, because no role on this row ever
 * reaches "full" (see the permission row's own comment: this is this
 * item's own judgment call, kept as its own row rather than folded into
 * `ACADEMY_STUDENT_PAYMENTS_ACTION`/`ACADEMY_EXPENSES_ACTION`).
 */
function canCreate(level: AcademyPermissionLevel): boolean {
  return level === "manage";
}

export interface IncomeRecordActionError {
  code: "forbidden" | "validation" | "blocked" | "not_found";
  message: string;
}

const FORBIDDEN: IncomeRecordActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's income records.",
};

export const createIncomeRecordSchema = z.object({
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

export type CreateIncomeRecordInput = z.input<typeof createIncomeRecordSchema>;

export interface IncomeRecordRecord {
  id: string;
  academyId: string;
  branchId: string | null;
  category: string;
  description: string | null;
  amountCents: number;
  currency: string;
  recordedBy: string;
  status: "posted" | "reversed";
  reversedRecordId: string | null;
  createdAt: Date;
}

function toRecord(row: typeof incomeRecords.$inferSelect): IncomeRecordRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    branchId: row.branchId,
    category: row.category,
    description: row.description,
    amountCents: row.amountCents,
    currency: row.currency,
    recordedBy: row.recordedBy,
    status: row.status,
    reversedRecordId: row.reversedRecordId,
    createdAt: row.createdAt,
  };
}

/** Same per-academy `default_currency` resolution as
 * lib/academies/student-payments.ts's `resolveCurrency` — kept as its own
 * copy here (file-local, not imported) since neither module is meant to
 * depend on the other. */
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

interface ResolvedIncomeAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveIncomeAccessResult =
  | { ok: true; access: ResolvedIncomeAccess }
  | { ok: false; error: IncomeRecordActionError };

async function resolveIncomeAccess(actorContext: AuthContext): Promise<ResolveIncomeAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(access.membershipRole, ACADEMY_INCOME_ACTION);
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

export type ListIncomeRecordsResult =
  | { ok: true; records: IncomeRecordRecord[]; canCreate: boolean }
  | { ok: false; error: IncomeRecordActionError };

/** Academy-wide read (Owner/Admin/Manager "view", Finance Officer
 * "manage" — all four non-"none" levels may list; only "manage" may
 * create, per `canCreate`). */
export async function listIncomeRecords(actorContext: AuthContext): Promise<ListIncomeRecordsResult> {
  const resolved = await resolveIncomeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel } = resolved.access;

  const rows = await db.select().from(incomeRecords).where(eq(incomeRecords.academyId, academyId));

  return { ok: true, records: rows.map(toRecord), canCreate: canCreate(permissionLevel) };
}

export type CreateIncomeRecordResult =
  | { ok: true; record: IncomeRecordRecord }
  | { ok: false; error: IncomeRecordActionError };

/**
 * PLAN.md's Finance Lifecycle table: income is "posted directly ... no
 * approval step." Always writes `status: "posted"` (the table's own DB
 * default) — no other status is ever reachable through this function.
 */
export async function createIncomeRecord(
  actorContext: AuthContext,
  input: CreateIncomeRecordInput,
): Promise<CreateIncomeRecordResult> {
  const resolved = await resolveIncomeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canCreate(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createIncomeRecordSchema.safeParse(input);
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
      .insert(incomeRecords)
      .values({
        academyId,
        branchId: data.branchId,
        category: data.category,
        description: data.description,
        amountCents: data.amountCents,
        currency,
        recordedBy: actorContext.userId,
      })
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "createIncomeRecord",
        entityType: "income_record",
        entityId: row.id,
        after: toRecord(row),
      },
      tx,
    );

    return row;
  });

  return { ok: true, record: toRecord(result) };
}
