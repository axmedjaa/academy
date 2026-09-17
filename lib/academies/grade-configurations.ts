import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { approvalRequests, gradeBands, gradeConfigurations } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_GRADE_BANDS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { createApprovalRequest, decideApprovalRequest } from "@/lib/academies/approval-requests";

/**
 * PLAN.md Phase 3, Item 46 — "`grade_configurations`/`grade_bands` +
 * exclusion constraint."
 *
 * ---------------------------------------------------------------------
 * Scope: what this item builds vs. what it deliberately does not
 * ---------------------------------------------------------------------
 * The Grade-Configuration Lifecycle table (PLAN.md, Lifecycle &
 * State-Transition Tables) is Draft -> Pending Approval -> Approved ->
 * Active/Retired, driven by `submitGradeConfigForApproval`/
 * `approveGradeConfig`. This item builds only the schema, the DB-level
 * no-overlap guarantee (see lib/db/schema.ts's comment on `gradeBands` for
 * why the exclusion constraint itself lives in hand-appended migration SQL,
 * not in this Drizzle table definition), and plain CRUD confined to the
 * `draft` status: `createGradeConfiguration` (always starts at `draft`,
 * per the lifecycle table's own `— -> Draft` row) and `updateGradeBands`
 * (full replace-the-band-set semantics). `submitGradeConfigForApproval`/
 * `approveGradeConfig` and the `/academy/grades` page are a separate,
 * later item — not built here. `updateGradeBands` therefore refuses to
 * touch a configuration that isn't `draft` (its state.status !== 'draft'
 * check below): once a later item moves a configuration past `draft`, the
 * band-set becomes that later item's concern (Active configurations get
 * a new Draft revision instead of in-place edits, per the lifecycle
 * table's own "any change creates a new Draft revision instead" row).
 *
 * No UI is built for this item (judgment call, documented per the task
 * brief): a bare CRUD page with no approval controls would be premature
 * given `/academy/grades` is explicitly the next item's page to build, and
 * this item's own brief explicitly says "No page/UI required for this
 * item." Logic + tests only.
 *
 * ---------------------------------------------------------------------
 * Permission gating
 * ---------------------------------------------------------------------
 * Master Permission Matrix "Grade-band configuration" row:
 * Full(owner)/Manage(admin)/"Manage/Approve"(manager)/—/—/—, scope n/a (no
 * branch-limited variant at all — unlike every other row this codebase has
 * gated so far, Admissions Officer/Trainer get no visibility here). See
 * lib/auth/academy-permissions.ts's ACADEMY_GRADE_BANDS_ACTION comment for
 * the "full" vs. "manage" level judgment call on Manager/Admin. Both
 * levels are treated identically by this item's plain CRUD (create/update
 * bands) — the distinction only starts mattering once the later approval
 * item gates `approveGradeConfig` on "full" specifically (Owner/Manager,
 * never Academy Administrator).
 *
 * ---------------------------------------------------------------------
 * Item 47 addendum — the approval flow this file's own comment above once
 * called "a separate, later item"
 * ---------------------------------------------------------------------
 * `submitGradeConfigForApproval`, `approveGradeConfig`, `rejectGradeConfig`,
 * and `activateGradeConfiguration` (below `updateGradeBands`) are that later
 * item, PLAN.md Item 47. They live in this same file rather than a new
 * sibling module: every one of them needs `resolveGradeConfigAccess`,
 * `canManage`, `toConfigRecord`/`toBandRecord`, `FORBIDDEN`/`NOT_FOUND`, and
 * `GradeConfigActionError` — all private to this file — and splitting the
 * four lifecycle transitions into a second file would mean either exporting
 * all of that plumbing (widening this module's public surface for no
 * consumer outside itself) or duplicating it. Keeping one file per entity
 * (`grade_configurations`/`grade_bands`) also matches this codebase's
 * existing convention elsewhere (e.g. `lifecycle.ts` holds every
 * `academies` state-transition action, not one file per transition).
 *
 * These four functions delegate to Item 50a's `lib/academies/
 * approval-requests.ts` (`createApprovalRequest`/`decideApprovalRequest`)
 * for the actual approval-queue bookkeeping and self-approval/one-shot-
 * decision guards, per this item's brief — no self-approval check or
 * approval-queue logic is reimplemented here. See `canApprove` below for
 * the narrower "full"-only gate `approveGradeConfig`/`rejectGradeConfig`
 * use (vs. `canManage`'s "full"-or-"manage" gate for every other action in
 * this file).
 */
function canManage(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

/**
 * `approveGradeConfig`/`rejectGradeConfig` gate: PLAN.md's grade-
 * configuration lifecycle table gives this transition to "Manager, and
 * Academy Owner via their existing Full authority — not Academy
 * Administrator". lib/auth/academy-permissions.ts's ACADEMY_GRADE_BANDS_ACTION
 * row (Item 46) already encodes exactly that split: academy_owner="full",
 * manager="full", academy_admin="manage" — so checking `level === "full"`
 * here (not `canManage`'s "full"-or-"manage") is precisely "Owner or
 * Manager, never Admin". Deliberately not "any nonzero permission": Admin's
 * "manage" level must fail this check even though it passes `canManage`.
 */
function canApprove(level: AcademyPermissionLevel): boolean {
  return level === "full";
}

export interface GradeConfigActionError {
  code:
    | "forbidden"
    | "validation"
    | "not_found"
    | "blocked"
    | "conflict"
    | "invalid_state"
    // Item 47: distinct codes for decideApprovalRequest's (Item 50a) two
    // guard failures, surfaced as-is rather than collapsed into "forbidden"
    // — so a submitter attempting to approve/reject their own submission
    // (self_approval) is distinguishable from a request that was already
    // decided by someone else in a race (already_decided), and both are
    // distinguishable from a plain permission-level refusal.
    | "self_approval"
    | "already_decided";
  message: string;
}

const FORBIDDEN: GradeConfigActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's grade configurations.",
};

const NOT_FOUND: GradeConfigActionError = {
  code: "not_found",
  message: "Grade configuration not found.",
};

export const createGradeConfigurationSchema = z.object({
  name: z.string().trim().min(1, "Configuration name is required").max(200),
});

export type CreateGradeConfigurationInput = z.input<typeof createGradeConfigurationSchema>;

export const gradeBandInputSchema = z
  .object({
    label: z.string().trim().min(1, "Band label is required").max(100),
    minMark: z.union([z.number(), z.string()]).transform((value) => Number(value)),
    maxMark: z.union([z.number(), z.string()]).transform((value) => Number(value)),
    isPass: z.boolean(),
  })
  .refine((band) => Number.isFinite(band.minMark) && Number.isFinite(band.maxMark), {
    message: "minMark/maxMark must be numbers",
  })
  .refine((band) => band.maxMark >= band.minMark, {
    message: "Each band's maxMark must be >= its minMark",
  });

export type GradeBandInput = z.input<typeof gradeBandInputSchema>;

export const updateGradeBandsSchema = z.array(gradeBandInputSchema);

export interface GradeConfigurationRecord {
  id: string;
  academyId: string;
  name: string;
  status: "draft" | "pending_approval" | "approved" | "active" | "retired";
  createdBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  activatedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
  /**
   * Item 47 addition — the `requestedBy` of this configuration's most
   * recent `approval_requests` row (any status), or `null` if it has never
   * been submitted for approval. Not a schema column on `grade_configurations`
   * itself (PLAN.md's column list for this table has no "submitted_by"),
   * so it's populated by a best-effort join against `approval_requests`
   * only where a caller actually needs it (`listGradeConfigurations`,
   * for `/academy/grades`'s DESIGN.md §11.4 "disable Approve on your own
   * submission" rule) — `undefined` everywhere else (createGradeConfiguration,
   * updateGradeBands, and this file's own four lifecycle actions all return
   * a fresh record via `toConfigRecord` without this field, since none of
   * them need to answer "who submitted this" about the row they just wrote).
   */
  submittedBy?: string | null;
}

export interface GradeBandRecord {
  id: string;
  gradeConfigurationId: string;
  label: string;
  minMark: number;
  maxMark: number;
  isPass: boolean;
}

function toConfigRecord(row: typeof gradeConfigurations.$inferSelect): GradeConfigurationRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    name: row.name,
    status: row.status,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    activatedAt: row.activatedAt,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
  };
}

function toBandRecord(row: typeof gradeBands.$inferSelect): GradeBandRecord {
  return {
    id: row.id,
    gradeConfigurationId: row.gradeConfigurationId,
    label: row.label,
    minMark: Number(row.minMark),
    maxMark: Number(row.maxMark),
    isPass: row.isPass,
  };
}

/**
 * Postgres exclusion_violation (23P01) — the runtime enforcement of
 * `grade_bands_no_overlap` (see lib/db/schema.ts's comment on `gradeBands`).
 * Same double-wrapped-error detection shape as every other
 * `isUniqueViolation` in this codebase (drizzle-orm wraps the raw `pg`
 * DatabaseError in its own `DrizzleQueryError`, so `code` lives on
 * `err.cause`, not `err` itself) — checked at both levels defensively.
 */
function isExclusionViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23P01") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23P01"
  );
}

function isCheckViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23514") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23514"
  );
}

/**
 * Application-level pre-check mirroring the DB exclusion constraint's exact
 * semantics (inclusive on both ends — see lib/db/schema.ts's comment on
 * why the hand-appended constraint uses numrange's `'[]'` bound spec, not
 * Postgres's default `'[)'`): two bands overlap iff `a.min <= b.max &&
 * b.min <= a.max`. This exists purely to give a friendlier "validation"
 * error before round-tripping to Postgres for the common case — the DB
 * constraint (tested directly in grade-configurations.test.ts) remains the
 * actual, unconditional source of truth, including for any future caller
 * that bypasses this pre-check.
 */
function findOverlap(bands: { minMark: number; maxMark: number }[]): boolean {
  for (let i = 0; i < bands.length; i += 1) {
    for (let j = i + 1; j < bands.length; j += 1) {
      const a = bands[i];
      const b = bands[j];
      if (a.minMark <= b.maxMark && b.minMark <= a.maxMark) {
        return true;
      }
    }
  }
  return false;
}

interface ResolvedGradeConfigAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveGradeConfigAccessResult =
  | { ok: true; access: ResolvedGradeConfigAccess }
  | { ok: false; error: GradeConfigActionError };

async function resolveGradeConfigAccess(
  actorContext: AuthContext,
): Promise<ResolveGradeConfigAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(
    access.membershipRole,
    ACADEMY_GRADE_BANDS_ACTION,
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

/**
 * Item 47 helper for `GradeConfigurationRecord.submittedBy` (see that
 * field's own doc comment): for each given configuration id, the
 * `requestedBy` of its most recent `approval_requests` row, across every
 * status — a rejected-then-resubmitted config's *previous* submitter still
 * shouldn't see an Approve button on their own new submission, and a config
 * that has never been submitted simply gets no entry (mapped to `null` at
 * the call site).
 */
async function getLatestApprovalSubmitterMap(
  gradeConfigurationIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (gradeConfigurationIds.length === 0) return result;

  const rows = await db
    .select({
      entityId: approvalRequests.entityId,
      requestedBy: approvalRequests.requestedBy,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.entityType, "grade_configuration"),
        inArray(approvalRequests.entityId, gradeConfigurationIds),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt));

  for (const row of rows) {
    if (!result.has(row.entityId)) {
      result.set(row.entityId, row.requestedBy); // first row per id = most recent, thanks to the ORDER BY above
    }
  }
  return result;
}

export type ListGradeConfigurationsResult =
  | {
      ok: true;
      configurations: GradeConfigurationRecord[];
      /** Can create/submit/activate (canManage's "full"-or-"manage" gate) — drives
       * whether `/academy/grades` shows Create/Submit/Activate controls at all. */
      canManage: boolean;
      /** Can approve/reject (canApprove's "full"-only gate) — drives whether
       * `/academy/grades` shows Approve/Reject controls at all (still disabled
       * per-row for the current user's own submission, see `submittedBy`). */
      canApprove: boolean;
    }
  | { ok: false; error: GradeConfigActionError };

export async function listGradeConfigurations(
  actorContext: AuthContext,
): Promise<ListGradeConfigurationsResult> {
  const resolved = await resolveGradeConfigAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel } = resolved.access;

  const rows = await db
    .select()
    .from(gradeConfigurations)
    .where(eq(gradeConfigurations.academyId, academyId));

  const submitterByConfigId = await getLatestApprovalSubmitterMap(rows.map((row) => row.id));

  return {
    ok: true,
    configurations: rows.map((row) => ({
      ...toConfigRecord(row),
      submittedBy: submitterByConfigId.get(row.id) ?? null,
    })),
    canManage: canManage(permissionLevel),
    canApprove: canApprove(permissionLevel),
  };
}

export type GetGradeConfigurationResult =
  | { ok: true; configuration: GradeConfigurationRecord; bands: GradeBandRecord[] }
  | { ok: false; error: GradeConfigActionError };

/** Tenant-scoped single read (config + its bands). IDOR-safe: nonexistent
 * or cross-academy id both return the identical generic `not_found`. */
export async function getGradeConfiguration(
  actorContext: AuthContext,
  gradeConfigurationId: string,
): Promise<GetGradeConfigurationResult> {
  const resolved = await resolveGradeConfigAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const parsedId = z.string().uuid().safeParse(gradeConfigurationId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [row] = await db
    .select()
    .from(gradeConfigurations)
    .where(and(eq(gradeConfigurations.id, gradeConfigurationId), eq(gradeConfigurations.academyId, academyId)))
    .limit(1);
  if (!row) {
    return { ok: false, error: NOT_FOUND };
  }

  const bandRows = await db
    .select()
    .from(gradeBands)
    .where(eq(gradeBands.gradeConfigurationId, gradeConfigurationId));

  return { ok: true, configuration: toConfigRecord(row), bands: bandRows.map(toBandRecord) };
}

export type CreateGradeConfigurationResult =
  | { ok: true; configuration: GradeConfigurationRecord }
  | { ok: false; error: GradeConfigActionError };

/** PLAN.md's Grade-Configuration Lifecycle table: `— -> Draft` via
 * `createGradeConfiguration`, actor Admin/Manager (Owner reaches the same
 * "full" gate via its existing Full authority on this row). */
export async function createGradeConfiguration(
  actorContext: AuthContext,
  input: CreateGradeConfigurationInput,
): Promise<CreateGradeConfigurationResult> {
  const resolved = await resolveGradeConfigAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createGradeConfigurationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(gradeConfigurations)
      .values({ academyId, name: data.name, createdBy: actorContext.userId })
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "createGradeConfiguration",
        entityType: "grade_configuration",
        entityId: row.id,
        after: toConfigRecord(row),
      },
      tx,
    );

    return row;
  });

  return { ok: true, configuration: toConfigRecord(result) };
}

export type UpdateGradeBandsResult =
  | { ok: true; bands: GradeBandRecord[] }
  | { ok: false; error: GradeConfigActionError };

/**
 * Full replace-the-band-set semantics: every existing band row for this
 * configuration is deleted and the given set is inserted fresh, inside one
 * transaction — never a partial/merge update. Re-validates no overlap
 * (via `findOverlap`) before writing, but the actual, unconditional
 * guarantee is the DB exclusion constraint (`grade_bands_no_overlap`),
 * checked again below on the real insert and surfaced as a `conflict`
 * error if it somehow fires despite the pre-check (e.g. a future caller
 * bypassing this function's own validation).
 *
 * Only callable while the configuration is still `draft` — see this
 * module's top comment for why (the approval flow, a separate later item,
 * owns every other status).
 */
export async function updateGradeBands(
  actorContext: AuthContext,
  gradeConfigurationId: string,
  input: GradeBandInput[],
): Promise<UpdateGradeBandsResult> {
  const resolved = await resolveGradeConfigAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(gradeConfigurationId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsed = updateGradeBandsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const bands = parsed.data;

  if (findOverlap(bands)) {
    return {
      ok: false,
      error: { code: "validation", message: "Grade bands must not overlap." },
    };
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [config] = await tx
        .select()
        .from(gradeConfigurations)
        .where(and(eq(gradeConfigurations.id, gradeConfigurationId), eq(gradeConfigurations.academyId, academyId)))
        .limit(1);
      if (!config) {
        return { kind: "not_found" as const };
      }
      if (config.status !== "draft") {
        return { kind: "invalid_state" as const };
      }

      const before = await tx
        .select()
        .from(gradeBands)
        .where(eq(gradeBands.gradeConfigurationId, gradeConfigurationId));

      await tx.delete(gradeBands).where(eq(gradeBands.gradeConfigurationId, gradeConfigurationId));

      const inserted =
        bands.length === 0
          ? []
          : await tx
              .insert(gradeBands)
              .values(
                bands.map((band) => ({
                  gradeConfigurationId,
                  label: band.label,
                  minMark: String(band.minMark),
                  maxMark: String(band.maxMark),
                  isPass: band.isPass,
                })),
              )
              .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "updateGradeBands",
          entityType: "grade_configuration",
          entityId: gradeConfigurationId,
          before: before.map(toBandRecord),
          after: inserted.map(toBandRecord),
        },
        tx,
      );

      return { kind: "ok" as const, bands: inserted };
    });

    if (result.kind === "not_found") {
      return { ok: false, error: NOT_FOUND };
    }
    if (result.kind === "invalid_state") {
      return {
        ok: false,
        error: {
          code: "invalid_state",
          message: "Grade bands can only be edited while the configuration is in draft status.",
        },
      };
    }

    return { ok: true, bands: result.bands.map(toBandRecord) };
  } catch (err) {
    if (isExclusionViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "Grade bands must not overlap." },
      };
    }
    if (isCheckViolation(err)) {
      return {
        ok: false,
        error: { code: "validation", message: "Each band's maxMark must be >= its minMark." },
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PLAN.md Item 47 — the Grade-Configuration Lifecycle table's four
// remaining transitions. See this file's "Item 47 addendum" comment above
// `canManage`/`canApprove` for why these live here rather than a new file.
// ---------------------------------------------------------------------------

export type SubmitGradeConfigForApprovalResult =
  | { ok: true; configuration: GradeConfigurationRecord }
  | { ok: false; error: GradeConfigActionError };

/**
 * Lifecycle table: `Draft -> Pending Approval` via
 * `submitGradeConfigForApproval`, actor Admin/Manager (Owner reaches the
 * same `canManage` gate via its existing "full" level). Flips the
 * configuration's own status AND creates the
 * `entityType: "grade_configuration"` approval_requests row (Item 50a's
 * `createApprovalRequest`) in one transaction — this is the only
 * approval_requests row `approveGradeConfig`/`rejectGradeConfig` will ever
 * look for (queried there by entityType + entityId + status="pending"), so
 * there is exactly one live request per configuration at a time: this
 * function refuses to run again on a configuration that isn't `draft`
 * (below), and a configuration only ever returns to `draft` via
 * `rejectGradeConfig`, which decides (closes) the old request first.
 */
export async function submitGradeConfigForApproval(
  actorContext: AuthContext,
  gradeConfigurationId: string,
): Promise<SubmitGradeConfigForApprovalResult> {
  const resolved = await resolveGradeConfigAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(gradeConfigurationId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [config] = await tx
      .select()
      .from(gradeConfigurations)
      .where(
        and(eq(gradeConfigurations.id, gradeConfigurationId), eq(gradeConfigurations.academyId, academyId)),
      )
      .limit(1);
    if (!config) {
      return { kind: "not_found" as const };
    }
    if (config.status !== "draft") {
      return { kind: "invalid_state" as const };
    }

    const [updated] = await tx
      .update(gradeConfigurations)
      .set({ status: "pending_approval", updatedAt: new Date() })
      .where(eq(gradeConfigurations.id, gradeConfigurationId))
      .returning();

    const requestResult = await createApprovalRequest(tx, {
      academyId,
      entityType: "grade_configuration",
      entityId: gradeConfigurationId,
      requestedBy: actorContext.userId,
    });
    if (!requestResult.ok) {
      // createApprovalRequest's only failure mode is zod validation on a
      // payload this function has already built from trusted, verified
      // values (a real academyId/entityId/requestedBy) — unreachable in
      // practice, but surfaced (and rolled back, since this throws inside
      // the transaction) rather than silently leaving the config's status
      // flipped with no matching approval request.
      throw new Error(`createApprovalRequest failed unexpectedly: ${requestResult.error.message}`);
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "submitGradeConfigForApproval",
        entityType: "grade_configuration",
        entityId: gradeConfigurationId,
        before: { status: config.status },
        after: { status: updated.status, approvalRequestId: requestResult.request.id },
      },
      tx,
    );

    return { kind: "ok" as const, configuration: updated };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: NOT_FOUND };
  }
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: {
        code: "invalid_state",
        message: "Only a draft configuration can be submitted for approval.",
      },
    };
  }
  return { ok: true, configuration: toConfigRecord(result.configuration) };
}

/**
 * Shared by `approveGradeConfig`/`rejectGradeConfig`: the one `pending`
 * `approval_requests` row for this configuration, if any. Both callers
 * treat a missing row as `invalid_state` rather than `not_found` — it means
 * the configuration's own status says `pending_approval` but no live
 * request backs it, which this module's own public API never produces
 * (see `submitGradeConfigForApproval`'s doc comment) but is handled
 * defensively rather than assumed impossible.
 */
async function findPendingApprovalRequest(tx: DbClient, gradeConfigurationId: string) {
  const [pending] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.entityType, "grade_configuration"),
        eq(approvalRequests.entityId, gradeConfigurationId),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);
  return pending ?? null;
}

/** Maps `decideApprovalRequest`'s (Item 50a) error codes onto this file's
 * own `GradeConfigActionError` shape without collapsing them — see the
 * `self_approval`/`already_decided` codes' own doc comment above. */
function mapDecisionError(error: { code: string; message: string }): GradeConfigActionError {
  if (error.code === "self_approval" || error.code === "already_decided") {
    return { code: error.code, message: error.message };
  }
  return { code: "validation", message: error.message };
}

export type ApproveGradeConfigResult =
  | { ok: true; configuration: GradeConfigurationRecord }
  | { ok: false; error: GradeConfigActionError };

/**
 * Lifecycle table: `Pending Approval -> Approved`, actor "Manager, and
 * Academy Owner via their existing Full authority — not Academy
 * Administrator" — gated on `canApprove` (permissionLevel === "full"
 * exactly), never `canManage`. Delegates the actual decision — including
 * the self-approval block and the one-shot-decision guard — to Item 50a's
 * `decideApprovalRequest`; this function's only added value is resolving
 * which pending `approval_requests` row belongs to this configuration and
 * flipping the configuration's own `status`/`approved_by`/`approved_at` in
 * the same transaction as that decision.
 */
export async function approveGradeConfig(
  actorContext: AuthContext,
  gradeConfigurationId: string,
): Promise<ApproveGradeConfigResult> {
  const resolved = await resolveGradeConfigAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canApprove(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(gradeConfigurationId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [config] = await tx
      .select()
      .from(gradeConfigurations)
      .where(
        and(eq(gradeConfigurations.id, gradeConfigurationId), eq(gradeConfigurations.academyId, academyId)),
      )
      .limit(1);
    if (!config) {
      return { kind: "not_found" as const };
    }
    if (config.status !== "pending_approval") {
      return { kind: "invalid_state" as const };
    }

    const pending = await findPendingApprovalRequest(tx, gradeConfigurationId);
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
      .update(gradeConfigurations)
      .set({
        status: "approved",
        approvedBy: actorContext.userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(gradeConfigurations.id, gradeConfigurationId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "approveGradeConfig",
        entityType: "grade_configuration",
        entityId: gradeConfigurationId,
        before: { status: config.status },
        after: { status: updated.status, approvedBy: updated.approvedBy },
      },
      tx,
    );

    return { kind: "ok" as const, configuration: updated };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: NOT_FOUND };
  }
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "Only a configuration pending approval can be approved." },
    };
  }
  if (result.kind === "decision_error") {
    return { ok: false, error: mapDecisionError(result.error) };
  }
  return { ok: true, configuration: toConfigRecord(result.configuration) };
}

export const rejectGradeConfigReasonSchema = z
  .string()
  .trim()
  .min(1, "A rejection reason is required.")
  .max(2000);

export type RejectGradeConfigResult =
  | { ok: true; configuration: GradeConfigurationRecord }
  | { ok: false; error: GradeConfigActionError };

/**
 * Lifecycle table: `Pending Approval` back to `Draft`, "rejected", same
 * approval-authority scoping as `approveGradeConfig` above, "reason
 * required". Same `canApprove`/`decideApprovalRequest` delegation as
 * `approveGradeConfig` — the only two differences: the target status is
 * `draft` (the *same row*, per PLAN.md's note that a rejected config is
 * re-editable via `updateGradeBands` once it's back in `draft`), and
 * `approved_by`/`approved_at` are left untouched (this was never approved).
 *
 * Reason storage: Item 50a's `decideApprovalRequest` input shape is
 * `{ decidedBy, status }` only — its own `reason` field is populated at
 * *request creation* time, not decision time (see approval-requests.ts's
 * `createApprovalRequestInputSchema`). Rather than widening that module's
 * signature (off-limits — read-only this item), the required rejection
 * reason is written directly onto the same `approval_requests` row's
 * `reason` column here, in the same transaction, immediately after
 * `decideApprovalRequest` has already applied its own guards and flipped
 * the row to `rejected`. This does not duplicate or bypass any of
 * `decideApprovalRequest`'s guards (self-approval, one-shot-decision) — it
 * only persists a column that function's own signature doesn't accept.
 */
export async function rejectGradeConfig(
  actorContext: AuthContext,
  gradeConfigurationId: string,
  reason: string,
): Promise<RejectGradeConfigResult> {
  const resolved = await resolveGradeConfigAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canApprove(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(gradeConfigurationId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsedReason = rejectGradeConfigReasonSchema.safeParse(reason);
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
    const [config] = await tx
      .select()
      .from(gradeConfigurations)
      .where(
        and(eq(gradeConfigurations.id, gradeConfigurationId), eq(gradeConfigurations.academyId, academyId)),
      )
      .limit(1);
    if (!config) {
      return { kind: "not_found" as const };
    }
    if (config.status !== "pending_approval") {
      return { kind: "invalid_state" as const };
    }

    const pending = await findPendingApprovalRequest(tx, gradeConfigurationId);
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
      .update(gradeConfigurations)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(gradeConfigurations.id, gradeConfigurationId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "rejectGradeConfig",
        entityType: "grade_configuration",
        entityId: gradeConfigurationId,
        before: { status: config.status },
        after: { status: updated.status, reason: parsedReason.data },
      },
      tx,
    );

    return { kind: "ok" as const, configuration: updated };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: NOT_FOUND };
  }
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "Only a configuration pending approval can be rejected." },
    };
  }
  if (result.kind === "decision_error") {
    return { ok: false, error: mapDecisionError(result.error) };
  }
  return { ok: true, configuration: toConfigRecord(result.configuration) };
}

export type ActivateGradeConfigurationResult =
  | {
      ok: true;
      configuration: GradeConfigurationRecord;
      /** The academy's previously `active` configuration, now `retired` in
       * the same transaction — `null` if this academy had none (first-ever
       * activation). */
      retiredConfiguration: GradeConfigurationRecord | null;
    }
  | { ok: false; error: GradeConfigActionError };

/**
 * Lifecycle table: `Approved -> Active`, actor Admin/Manager (Owner via
 * Full) — `canManage`'s gate, NOT `canApprove`'s narrower one (activation
 * is a separate action from the approval decision, and PLAN.md's own actor
 * column for this row says "Admin/Manager", matching every other
 * `canManage`-gated row in this file).
 *
 * "Only one Active configuration per academy at a time ... the previously
 * Active row (if any) flips to Retired in the same transaction": both
 * writes (the previously-active row's flip to `retired`, and this
 * configuration's flip to `active`) happen inside the one `db.transaction`
 * below, so a failure on either half rolls back both — there is no window
 * where an academy briefly has zero or two `active` rows. Covered directly
 * in this file's test suite, including a forced failure on the second
 * write to prove the first write's rollback.
 */
export async function activateGradeConfiguration(
  actorContext: AuthContext,
  gradeConfigurationId: string,
): Promise<ActivateGradeConfigurationResult> {
  const resolved = await resolveGradeConfigAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(gradeConfigurationId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [config] = await tx
      .select()
      .from(gradeConfigurations)
      .where(
        and(eq(gradeConfigurations.id, gradeConfigurationId), eq(gradeConfigurations.academyId, academyId)),
      )
      .limit(1);
    if (!config) {
      return { kind: "not_found" as const };
    }
    if (config.status !== "approved") {
      return { kind: "invalid_state" as const };
    }

    const [previouslyActive] = await tx
      .select()
      .from(gradeConfigurations)
      .where(and(eq(gradeConfigurations.academyId, academyId), eq(gradeConfigurations.status, "active")))
      .limit(1);

    const now = new Date();
    let retired: typeof gradeConfigurations.$inferSelect | null = null;
    if (previouslyActive) {
      const [retiredRow] = await tx
        .update(gradeConfigurations)
        .set({ status: "retired", retiredAt: now, updatedAt: now })
        .where(eq(gradeConfigurations.id, previouslyActive.id))
        .returning();
      retired = retiredRow;
    }

    const [updated] = await tx
      .update(gradeConfigurations)
      .set({ status: "active", activatedAt: now, updatedAt: now })
      .where(eq(gradeConfigurations.id, gradeConfigurationId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "activateGradeConfiguration",
        entityType: "grade_configuration",
        entityId: gradeConfigurationId,
        before: { status: config.status },
        after: { status: updated.status, retiredConfigurationId: retired?.id ?? null },
      },
      tx,
    );

    return { kind: "ok" as const, configuration: updated, retired };
  });

  if (result.kind === "not_found") {
    return { ok: false, error: NOT_FOUND };
  }
  if (result.kind === "invalid_state") {
    return {
      ok: false,
      error: { code: "invalid_state", message: "Only an approved configuration can be activated." },
    };
  }
  return {
    ok: true,
    configuration: toConfigRecord(result.configuration),
    retiredConfiguration: result.retired ? toConfigRecord(result.retired) : null,
  };
}
