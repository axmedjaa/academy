import { cache } from "react";
import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { db, type DbClient } from "@/lib/db";
import { batches, branches, staffBranchAssignments, staffProfiles, students } from "@/lib/db/schema";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Multi-branch authorization — the single source of truth for "which
 * branches may this academy member work in".
 *
 * One academy is one tenant; every branch-scoped read and write first
 * passes the tenant gate (lib/academies/access-gate.ts), then narrows to
 * the caller's branch scope here:
 *
 * - `academyWide` (the owner always; anyone else only with the owner's
 *   `academy_memberships.academy_wide` grant) — every branch of the academy.
 * - otherwise — only the branches the member's staff profile is assigned
 *   to (`staff_branch_assignments`). No assignment means no branch.
 *
 * Role permissions (lib/auth/academy-permissions.ts) still decide WHAT a
 * member may do; this decides WHERE. A client-supplied branch id is never
 * trusted: `canAccessBranch` checks it against this scope (and the tenant).
 */

export type BranchScope =
  | { academyWide: true }
  | { academyWide: false; branchIds: string[] };

/** What the scope needs from an allowed gate result. */
export interface BranchScopeAccess {
  academyId: string;
  academyWide: boolean;
}

/** The member's assigned branch ids in this academy (empty when the member
 * has no staff profile or no assignment). */
export async function getAssignedBranchIds(
  executor: DbClient,
  academyId: string,
  userId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ branchId: staffBranchAssignments.branchId })
    .from(staffBranchAssignments)
    .innerJoin(staffProfiles, eq(staffProfiles.id, staffBranchAssignments.staffProfileId))
    .where(and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, userId)));
  return rows.map((row) => row.branchId);
}

// Per-request dedup only (React `cache`), never across requests or users.
const assignedBranchIdsForRequest = cache((academyId: string, userId: string) =>
  getAssignedBranchIds(db, academyId, userId),
);

export async function getBranchScope(access: BranchScopeAccess, userId: string): Promise<BranchScope> {
  if (access.academyWide) return { academyWide: true };
  return { academyWide: false, branchIds: await assignedBranchIdsForRequest(access.academyId, userId) };
}

/** True when `branchId` belongs to the caller's academy AND is inside their
 * branch scope. Use for every client-supplied branch id. */
export async function canAccessBranch(
  access: BranchScopeAccess,
  userId: string,
  branchId: string,
  executor: DbClient = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.academyId, access.academyId)))
    .limit(1);
  if (!row) return false;
  const scope = await getBranchScope(access, userId);
  return scope.academyWide || scope.branchIds.includes(branchId);
}

/** SQL condition limiting `branchColumn` to the scope — `undefined` (no
 * extra condition) for academy-wide members, `false` for a member with no
 * branch at all. Combine with the query's own academy condition. */
export function branchScopeCondition(scope: BranchScope, branchColumn: AnyPgColumn | SQLWrapper): SQL | undefined {
  if (scope.academyWide) return undefined;
  if (scope.branchIds.length === 0) return sql`false`;
  return inArray(branchColumn as AnyPgColumn, scope.branchIds);
}

/** Rows linked to a student (payments, charges, fee periods, receipts…):
 * limits `studentIdColumn` to students of in-scope branches. */
export function studentInScopeCondition(
  scope: BranchScope,
  academyId: string,
  studentIdColumn: AnyPgColumn | SQLWrapper,
): SQL | undefined {
  if (scope.academyWide) return undefined;
  if (scope.branchIds.length === 0) return sql`false`;
  return inArray(
    studentIdColumn as AnyPgColumn,
    db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.academyId, academyId), inArray(students.branchId, scope.branchIds))),
  );
}

/** Rows linked to a batch (exams, results, certificates…): limits
 * `batchIdColumn` to batches of in-scope branches. */
export function batchInScopeCondition(
  scope: BranchScope,
  academyId: string,
  batchIdColumn: AnyPgColumn | SQLWrapper,
): SQL | undefined {
  if (scope.academyWide) return undefined;
  if (scope.branchIds.length === 0) return sql`false`;
  return inArray(
    batchIdColumn as AnyPgColumn,
    db
      .select({ id: batches.id })
      .from(batches)
      .where(and(eq(batches.academyId, academyId), inArray(batches.branchId, scope.branchIds))),
  );
}

/** Single-record checks for writes and detail reads. A record outside the
 * scope (or outside the academy) must be treated like a missing one. */
export async function isStudentInScope(
  scope: BranchScope,
  academyId: string,
  studentId: string,
  executor: DbClient = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ branchId: students.branchId })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.academyId, academyId)))
    .limit(1);
  return Boolean(row) && inBranchScope(scope, row.branchId);
}

export async function isBatchInScope(
  scope: BranchScope,
  academyId: string,
  batchId: string,
  executor: DbClient = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ branchId: batches.branchId })
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
    .limit(1);
  return Boolean(row) && inBranchScope(scope, row.branchId);
}

/** In-memory form of the same rule, for rows already loaded. */
export function inBranchScope(scope: BranchScope, branchId: string | null): boolean {
  if (scope.academyWide) return true;
  return branchId !== null && scope.branchIds.includes(branchId);
}

/** Academy-wide catalogue and settings (courses, programs, grade bands,
 * books, academy profile) affect every branch, so a member without
 * all-branch access may read them but not change them: any level other than
 * "none" becomes "view". */
export function viewOnlyWithoutAllBranches<L extends string>(level: L, academyWide: boolean): L | "view" {
  if (academyWide || level === "none") return level;
  return "view";
}
