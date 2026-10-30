import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  academyMemberships,
  batches,
  branches,
  staffBranchAssignments,
  staffProfiles,
  studentPayments,
  students,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { canAccessBranch, getBranchScope } from "@/lib/academies/branch-access";
import { listStaffSummaries } from "@/lib/academies/staff";
import { assignStaffBranches, listAssignedBranches, type StaffBranchActionError } from "@/lib/academies/staff-branch-assignments";
import {
  ACADEMY_STAFF_ACTION,
  ACADEMY_STUDENT_PAYMENTS_ACTION,
  ACADEMY_STUDENTS_ACTION,
  getAcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * Multi-branch reads and one write behind the branch pages: who works at a
 * branch (and adding or removing them), and the side-by-side branch
 * comparison. Every read is limited to the caller's academy and branch
 * scope (lib/academies/branch-access.ts); a branch outside it is the same
 * "not found" as a missing one. Assignment changes go through
 * `assignStaffBranches`, which enforces the scope rules and writes the
 * audit rows.
 */

export interface BranchOverviewError {
  code: "forbidden" | "not_found" | "blocked" | "validation";
  message: string;
}

const BRANCH_NOT_FOUND: BranchOverviewError = { code: "not_found", message: "Branch not found." };

export interface BranchStaffRow {
  staffProfileId: string;
  userId: string;
  fullName: string;
  status: "active" | "archived";
  /** Current academy role, or null when the membership was removed. */
  role: AcademyRole | null;
  /** Owner, or granted all-branch access. */
  allBranchAccess: boolean;
  assignedHere: boolean;
  /** Names of the other branches this person is assigned to. */
  otherBranches: string[];
}

export type ListBranchStaffResult =
  | {
      ok: true;
      branch: { id: string; name: string; isMain: boolean };
      staff: BranchStaffRow[];
      /** May add or remove staff at this branch (staff permission). */
      canAssign: boolean;
      /** May grant or revoke all-branch access: the owner, on the Main Branch. */
      canGrantAllBranches: boolean;
    }
  | { ok: false; error: BranchOverviewError };

/** Staff the caller can see, each marked as working at this branch or not. */
export async function listBranchStaff(actorContext: AuthContext, branchId: string): Promise<ListBranchStaffResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const staffLevel = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (staffLevel === "none") {
    return { ok: false, error: { code: "forbidden", message: "You don't have permission to view staff." } };
  }
  if (!z.string().uuid().safeParse(branchId).success || !(await canAccessBranch(access, actorContext.userId, branchId))) {
    return { ok: false, error: BRANCH_NOT_FOUND };
  }

  const [branchRows, visible] = await Promise.all([
    db
      .select({ id: branches.id, name: branches.name, isMain: branches.isMain })
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.academyId, access.academyId)))
      .limit(1),
    listStaffSummaries(actorContext),
  ]);
  const branch = branchRows[0];
  if (!branch || !visible.ok) return { ok: false, error: BRANCH_NOT_FOUND };

  const staffIds = visible.staff.map((member) => member.id);
  const [profiles, assignments] = staffIds.length
    ? await Promise.all([
        db
          .select({
            id: staffProfiles.id,
            userId: staffProfiles.userId,
            role: academyMemberships.role,
            academyWide: academyMemberships.academyWide,
          })
          .from(staffProfiles)
          .leftJoin(
            academyMemberships,
            and(
              eq(academyMemberships.userId, staffProfiles.userId),
              eq(academyMemberships.academyId, staffProfiles.academyId),
              eq(academyMemberships.status, "active"),
            ),
          )
          .where(and(eq(staffProfiles.academyId, access.academyId), inArray(staffProfiles.id, staffIds))),
        db
          .select({ staffProfileId: staffBranchAssignments.staffProfileId, branchId: branches.id, name: branches.name })
          .from(staffBranchAssignments)
          .innerJoin(branches, eq(branches.id, staffBranchAssignments.branchId))
          .where(and(eq(branches.academyId, access.academyId), inArray(staffBranchAssignments.staffProfileId, staffIds))),
      ])
    : [[], []];
  const profileById = new Map(profiles.map((row) => [row.id, row]));

  const staff: BranchStaffRow[] = visible.staff
    .map((member) => {
      const profile = profileById.get(member.id);
      const own = assignments.filter((row) => row.staffProfileId === member.id);
      return {
        staffProfileId: member.id,
        userId: profile?.userId ?? "",
        fullName: member.fullName,
        status: member.status,
        role: profile?.role ?? null,
        allBranchAccess: profile?.role === "academy_owner" || Boolean(profile?.academyWide),
        assignedHere: own.some((row) => row.branchId === branch.id),
        otherBranches: own.filter((row) => row.branchId !== branch.id).map((row) => row.name).sort((a, b) => a.localeCompare(b)),
      };
    })
    .sort((a, b) => Number(b.assignedHere) - Number(a.assignedHere) || a.fullName.localeCompare(b.fullName));

  return {
    ok: true,
    branch,
    staff,
    canAssign: staffLevel === "full" || staffLevel === "manage",
    canGrantAllBranches: access.membershipRole === "academy_owner" && branch.isMain,
  };
}

export type SetStaffBranchAssignmentResult =
  | { ok: true; branchIds: string[] }
  | { ok: false; error: StaffBranchActionError };

/** Adds a staff member to, or removes them from, one branch — keeping every
 * other assignment they have. */
export async function setStaffBranchAssignment(
  actorContext: AuthContext,
  staffProfileId: string,
  branchId: string,
  assigned: boolean,
): Promise<SetStaffBranchAssignmentResult> {
  if (!z.string().uuid().safeParse(branchId).success) {
    return { ok: false, error: { code: "not_found", message: "Branch not found." } };
  }
  const current = await listAssignedBranches(actorContext, staffProfileId);
  if (!current.ok) return current;
  const next = assigned
    ? [...new Set([...current.branchIds, branchId])]
    : current.branchIds.filter((id) => id !== branchId);
  return assignStaffBranches(actorContext, staffProfileId, next);
}

export interface BranchComparisonRow {
  branchId: string;
  name: string;
  isMain: boolean;
  status: "active" | "archived";
  activeStudents: number;
  activeBatches: number;
  staff: number;
  /** Approved payments received since the start of this month, per
   * currency — null when the caller may not see payments. */
  collectedThisMonth: { currency: string; amountCents: number }[] | null;
}

export type GetBranchComparisonResult =
  | { ok: true; rows: BranchComparisonRow[] }
  | { ok: false; error: BranchOverviewError };

/** One row per branch in the caller's scope, for side-by-side comparison. */
export async function getBranchComparison(actorContext: AuthContext): Promise<GetBranchComparisonResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  if (getAcademyPermissionLevel(access.membershipRole, ACADEMY_STUDENTS_ACTION) === "none") {
    return { ok: false, error: { code: "forbidden", message: "You don't have permission to compare branches." } };
  }
  const scope = await getBranchScope(access, actorContext.userId);
  const academyId = access.academyId;

  if (!scope.academyWide && scope.branchIds.length === 0) return { ok: true, rows: [] };

  const branchRows = await db
    .select({ id: branches.id, name: branches.name, isMain: branches.isMain, status: branches.status })
    .from(branches)
    .where(and(eq(branches.academyId, academyId), scope.academyWide ? undefined : inArray(branches.id, scope.branchIds)));
  const ids = branchRows.map((row) => row.id);
  if (ids.length === 0) return { ok: true, rows: [] };

  const canSeePayments = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STUDENT_PAYMENTS_ACTION) !== "none";
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [studentCounts, batchCounts, staffCounts, paymentRows] = await Promise.all([
    db
      .select({ branchId: students.branchId, count: sql<number>`count(*)::int` })
      .from(students)
      .where(and(eq(students.academyId, academyId), inArray(students.branchId, ids), eq(students.status, "active")))
      .groupBy(students.branchId),
    db
      .select({ branchId: batches.branchId, count: sql<number>`count(*)::int` })
      .from(batches)
      .where(and(eq(batches.academyId, academyId), inArray(batches.branchId, ids), eq(batches.status, "active")))
      .groupBy(batches.branchId),
    db
      .select({ branchId: staffBranchAssignments.branchId, count: sql<number>`count(*)::int` })
      .from(staffBranchAssignments)
      .innerJoin(staffProfiles, eq(staffProfiles.id, staffBranchAssignments.staffProfileId))
      .where(and(eq(staffProfiles.academyId, academyId), inArray(staffBranchAssignments.branchId, ids), eq(staffProfiles.status, "active")))
      .groupBy(staffBranchAssignments.branchId),
    canSeePayments
      ? db
          .select({
            branchId: students.branchId,
            currency: studentPayments.currency,
            amountCents: sql<number>`coalesce(sum(${studentPayments.amountCents}), 0)::int`,
          })
          .from(studentPayments)
          .innerJoin(students, eq(students.id, studentPayments.studentId))
          .where(
            and(
              eq(studentPayments.academyId, academyId),
              inArray(students.branchId, ids),
              eq(studentPayments.status, "approved"),
              isNull(studentPayments.reversedPaymentId),
              gte(studentPayments.receivedAt, monthStart),
            ),
          )
          .groupBy(students.branchId, studentPayments.currency)
      : Promise.resolve([]),
  ]);

  const countOf = (rows: { branchId: string; count: number }[], id: string) => rows.find((row) => row.branchId === id)?.count ?? 0;
  return {
    ok: true,
    rows: branchRows
      .map((branch) => ({
        branchId: branch.id,
        name: branch.name,
        isMain: branch.isMain,
        status: branch.status,
        activeStudents: countOf(studentCounts, branch.id),
        activeBatches: countOf(batchCounts, branch.id),
        staff: countOf(staffCounts, branch.id),
        collectedThisMonth: canSeePayments
          ? paymentRows
              .filter((row) => row.branchId === branch.id)
              .map((row) => ({ currency: row.currency, amountCents: row.amountCents }))
              .sort((a, b) => b.amountCents - a.amountCents)
          : null,
      }))
      .sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name)),
  };
}
