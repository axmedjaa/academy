import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { gradeBands, gradeConfigurations } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_GRADE_BANDS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

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
 */
function canManage(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

export interface GradeConfigActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict" | "invalid_state";
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

export type ListGradeConfigurationsResult =
  | { ok: true; configurations: GradeConfigurationRecord[] }
  | { ok: false; error: GradeConfigActionError };

export async function listGradeConfigurations(
  actorContext: AuthContext,
): Promise<ListGradeConfigurationsResult> {
  const resolved = await resolveGradeConfigAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const rows = await db
    .select()
    .from(gradeConfigurations)
    .where(eq(gradeConfigurations.academyId, academyId));

  return { ok: true, configurations: rows.map(toConfigRecord) };
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
