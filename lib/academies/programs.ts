import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { programs } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_COURSES_BATCHES_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 3, Item 43 — "Programs/courses/batches ... `createProgram`,
 * `createCourse` (`checkAllowance('courses')`), `createBatch`."
 *
 * Gating follows lib/academies/branches.ts's exact template: resolve
 * academy+role via `checkAcademyAccessForContext` (never a client-supplied
 * academyId), then consult lib/auth/academy-permissions.ts's
 * `"academy.courses_batches"` row (Full/Full/Manage/View/—/"Manage
 * assigned"). Programs have no `branch_id` column at all (PLAN.md's own
 * schema for this table) — they are academy-wide for every role that can
 * see them, so unlike lib/academies/batches.ts there is no
 * staff_branch_assignments join here.
 *
 * Judgment call on Trainer (documented in full on
 * lib/auth/academy-permissions.ts's ACADEMY_COURSES_BATCHES_ACTION
 * comment): the matrix's "Manage assigned" cell for Trainer only makes
 * sense against a branch-scoped entity, and programs have no such scope —
 * so despite holding the "manage" level on this action, Trainer is refused
 * create/archive here (same as Admissions Officer's plain "view" level),
 * and only sees the read-only list. Only Owner/Admin/Manager (the three
 * academy-wide "full"/"manage" roles that aren't branch-limited) may
 * create or archive a program.
 */
const TRAINER_ROLE: AcademyRole = "trainer";

function canManagePrograms(role: AcademyRole, level: AcademyPermissionLevel): boolean {
  return (level === "full" || level === "manage") && role !== TRAINER_ROLE;
}

export interface ProgramActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict";
  message: string;
}

const FORBIDDEN: ProgramActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's programs.",
};

const NOT_FOUND: ProgramActionError = {
  code: "not_found",
  message: "Program not found.",
};

function optionalText(maxLength = 2000) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

export const createProgramSchema = z.object({
  name: z.string().trim().min(1, "Program name is required").max(200),
  description: optionalText(2000),
});

export type CreateProgramInput = z.input<typeof createProgramSchema>;
export type UpdateProgramInput = CreateProgramInput;

export interface ProgramRecord {
  id: string;
  academyId: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  createdAt: Date;
}

function toRecord(row: typeof programs.$inferSelect): ProgramRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/**
 * Postgres unique_violation (23505) — same detection shape as
 * lib/academies/branches.ts's `isUniqueViolation`, duplicated here per
 * that file's own documented convention (each action file keeps its own
 * copy rather than importing a private helper from a sibling).
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

interface ResolvedProgramAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveProgramAccessResult =
  | { ok: true; access: ResolvedProgramAccess }
  | { ok: false; error: ProgramActionError };

async function resolveProgramAccess(
  actorContext: AuthContext,
): Promise<ResolveProgramAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(
    access.membershipRole,
    ACADEMY_COURSES_BATCHES_ACTION,
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

export type ListProgramsResult =
  | { ok: true; programs: ProgramRecord[]; canManage: boolean }
  | { ok: false; error: ProgramActionError };

/** Academy-wide read for every role holding any level on this action — no
 * branch scoping exists for programs (see module comment). */
export async function listPrograms(actorContext: AuthContext): Promise<ListProgramsResult> {
  const resolved = await resolveProgramAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const rows = await db.select().from(programs).where(eq(programs.academyId, academyId));

  return {
    ok: true,
    programs: rows.map(toRecord),
    canManage: canManagePrograms(membershipRole, permissionLevel),
  };
}

export type GetProgramResult =
  | { ok: true; program: ProgramRecord }
  | { ok: false; error: ProgramActionError };

/** Tenant-scoped single read; IDOR-safe (cross-academy id -> generic
 * not_found, same convention as branches.ts's getBranch). */
export async function getProgram(
  actorContext: AuthContext,
  programId: string,
): Promise<GetProgramResult> {
  const resolved = await resolveProgramAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const parsedId = z.string().uuid().safeParse(programId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [row] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.id, programId), eq(programs.academyId, academyId)))
    .limit(1);
  if (!row) {
    return { ok: false, error: NOT_FOUND };
  }

  return { ok: true, program: toRecord(row) };
}

export type CreateProgramResult =
  | { ok: true; program: ProgramRecord }
  | { ok: false; error: ProgramActionError };

export async function createProgram(
  actorContext: AuthContext,
  input: CreateProgramInput,
): Promise<CreateProgramResult> {
  const resolved = await resolveProgramAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManagePrograms(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createProgramSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(programs)
        .values({ academyId, name: data.name, description: data.description })
        .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "createProgram",
          entityType: "program",
          entityId: row.id,
          after: toRecord(row),
        },
        tx,
      );

      return row;
    });

    return { ok: true, program: toRecord(result) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "A program with that name already exists for this academy." },
      };
    }
    throw err;
  }
}

export type UpdateProgramResult =
  | { ok: true; program: ProgramRecord }
  | { ok: false; error: ProgramActionError };

export async function updateProgram(
  actorContext: AuthContext,
  programId: string,
  input: UpdateProgramInput,
): Promise<UpdateProgramResult> {
  const resolved = await resolveProgramAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManagePrograms(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(programId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsed = createProgramSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(programs)
        .where(and(eq(programs.id, programId), eq(programs.academyId, academyId)))
        .limit(1);
      if (!existing) return null;

      const [updated] = await tx
        .update(programs)
        .set({ name: data.name, description: data.description, updatedAt: new Date() })
        .where(eq(programs.id, programId))
        .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "updateProgram",
          entityType: "program",
          entityId: programId,
          before: toRecord(existing),
          after: toRecord(updated),
        },
        tx,
      );

      return updated;
    });

    if (!result) {
      return { ok: false, error: NOT_FOUND };
    }
    return { ok: true, program: toRecord(result) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "A program with that name already exists for this academy." },
      };
    }
    throw err;
  }
}

export type ArchiveProgramResult =
  | { ok: true; program: ProgramRecord }
  | { ok: false; error: ProgramActionError };

/** No hard delete — `status = archived` is the only removal path, same
 * convention as archiveBranch. Idempotent. */
export async function archiveProgram(
  actorContext: AuthContext,
  programId: string,
): Promise<ArchiveProgramResult> {
  const resolved = await resolveProgramAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManagePrograms(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(programId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(programs)
      .where(and(eq(programs.id, programId), eq(programs.academyId, academyId)))
      .limit(1);
    if (!existing) return null;

    const [updated] = await tx
      .update(programs)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(programs.id, programId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "archiveProgram",
        entityType: "program",
        entityId: programId,
        before: toRecord(existing),
        after: toRecord(updated),
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return { ok: false, error: NOT_FOUND };
  }
  return { ok: true, program: toRecord(result) };
}
