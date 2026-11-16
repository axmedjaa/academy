import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  batchCourses,
  auditLogs,
  batchEnrollments,
  batchTrainerAssignments,
  enrollmentFeeSchedules,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  assignTrainerToBatch,
  enrollStudentInBatch,
  getActiveCoursesForStudents,
  getAssignedBatchIds,
  listBatchEnrollments,
  listBatchTrainerAssignments,
  listMyAssignedBatches,
  unassignTrainerFromBatch,
  updateStudentEnrollment,
  withdrawStudentFromBatch,
  listEnrollmentWithdrawals,
} from "./batch-assignments";
import { courseOfBatch } from "@/lib/academies/test-batch-course";
import {
  registerFixtureCleanup,
  DEFAULT_PAYMENT_PLAN,
  createUser,
  addMembership,
  insertBranchDirect,
  insertProgramAndCourse,
  insertBatchDirect,
  insertStudentDirect,
  insertStaffProfile,
  assignUserToBranches,
  setupAcademy,
} from "./batch-assignments-test-fixtures";

/**
 * Batch assignments: trainer assignment, course-enrollment permissions and
 * rules, withdrawals, branch and tenant scoping, and the read helpers. The
 * initial payment plan and enrollment deletion tests live in
 * batch-enrollment-fees-deletion.test.ts; both share
 * batch-assignments-test-fixtures.ts.
 */

registerFixtureCleanup();

describe("assignTrainerToBatch — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
  ])("role %s: assign allowed = %s", async (role, allowed) => {
    const { context, academyId, batchId } = await setupAcademy(role);
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const result = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("trainer ('manage assigned') can assign a trainer within their own assigned branch", async () => {
    const { academyId, userId, context, branchId, batchId } = await setupAcademy("trainer");
    await assignUserToBranches(academyId, userId, [branchId]);
    const otherTrainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, otherTrainerUserId);

    const result = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(result.ok).toBe(true);
  });

  it("trainer cannot assign into a batch outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, courseId } = await setupAcademy("trainer");
    const otherBranch = await insertBranchDirect(academyId);
    const assignedBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const outOfScopeBatch = await insertBatchDirect(academyId, otherBranch, courseId);
    const otherTrainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, otherTrainerUserId);

    const result = await assignTrainerToBatch(context, { batchId: outOfScopeBatch, staffProfileId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a batch belonging to another academy with 'not_found' (cross-academy IDOR)", async () => {
    const other = await setupAcademy("academy_owner");
    const { context, academyId } = await setupAcademy("academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const result = await assignTrainerToBatch(context, { batchId: other.batchId, staffProfileId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent staffProfileId with 'not_found'", async () => {
    const { context, batchId } = await setupAcademy("academy_owner");
    const result = await assignTrainerToBatch(context, { batchId, staffProfileId: randomUUID() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("writes an audit row on successful assignment", async () => {
    const { context, academyId, userId, batchId } = await setupAcademy("academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const result = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, result.assignment.id));
    expect(audit?.action).toBe("assignTrainerToBatch");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });
});

describe("assign/unassign trainer — unique constraint + reactivation", () => {
  it("assigning the same staff member to the same batch twice while active is a conflict", async () => {
    const { context, academyId, batchId } = await setupAcademy("academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const first = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(first.ok).toBe(true);

    const second = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });

  it("unassigning then reassigning the same pair reactivates the same row (no duplicate insert)", async () => {
    const { context, academyId, batchId } = await setupAcademy("academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const first = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const unassigned = await unassignTrainerFromBatch(context, first.assignment.id);
    expect(unassigned.ok).toBe(true);
    if (unassigned.ok) expect(unassigned.assignment.status).toBe("removed");

    const reassigned = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(reassigned.ok).toBe(true);
    if (reassigned.ok) {
      expect(reassigned.assignment.id).toBe(first.assignment.id);
      expect(reassigned.assignment.status).toBe("active");
    }

    const rows = await db
      .select()
      .from(batchTrainerAssignments)
      .where(eq(batchTrainerAssignments.staffProfileId, staffProfileId));
    expect(rows.length).toBe(1);
  });

  it("unassigning an already-removed assignment returns 'invalid_transition'", async () => {
    const { context, academyId, batchId } = await setupAcademy("academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const created = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await unassignTrainerFromBatch(context, created.assignment.id);
    expect(first.ok).toBe(true);

    const second = await unassignTrainerFromBatch(context, created.assignment.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("invalid_transition");
  });

  it("trainer cannot unassign outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, courseId } = await setupAcademy("trainer");
    const otherBranch = await insertBranchDirect(academyId);
    const assignedBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const outOfScopeBatch = await insertBatchDirect(academyId, otherBranch, courseId);

    const ownerContext: AuthContext = { userId: await createUser(), branchIds: [], academyWide: false };
    await addMembership(ownerContext.userId, academyId, "academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);
    const created = await assignTrainerToBatch(ownerContext, { batchId: outOfScopeBatch, staffProfileId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await unassignTrainerFromBatch(context, created.assignment.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("enrollStudentInBatch — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
  ])("role %s: enroll allowed = %s", async (role, allowed) => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy(role);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("trainer ('manage assigned') can enroll within their own assigned branch", async () => {
    const { academyId, userId, context, branchId, batchId, creatorUserId } = await setupAcademy("trainer");
    await assignUserToBranches(academyId, userId, [branchId]);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(true);
  });

  it("trainer cannot enroll into a batch outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, courseId, creatorUserId } = await setupAcademy("trainer");
    const otherBranch = await insertBranchDirect(academyId);
    const assignedBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const outOfScopeBatch = await insertBatchDirect(academyId, otherBranch, courseId);
    const studentId = await insertStudentDirect(academyId, otherBranch, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId: outOfScopeBatch, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent studentId with 'not_found'", async () => {
    const { context, batchId } = await setupAcademy("academy_owner");
    const result = await enrollStudentInBatch(context, { batchId, studentId: randomUUID(), paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("writes an audit row on successful enrollment", async () => {
    const { context, academyId, branchId, batchId, creatorUserId, userId } = await setupAcademy(
      "academy_owner",
    );
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, result.enrollment.id));
    expect(audit?.action).toBe("enrollStudentInBatch");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });
});

describe("cross-academy integrity check — enrollStudentInBatch", () => {
  it("rejects enrollment when the student belongs to a different academy than the batch", async () => {
    const home = await setupAcademy("academy_owner");
    const other = await setupAcademy("academy_owner");
    const otherAcademyStudentId = await insertStudentDirect(
      other.academyId,
      other.branchId,
      other.creatorUserId,
    );

    const result = await enrollStudentInBatch(home.context, {
      batchId: home.batchId,
      studentId: otherAcademyStudentId,
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects enrollment when the batch belongs to a different academy than the student", async () => {
    const home = await setupAcademy("academy_owner");
    const other = await setupAcademy("academy_owner");
    const homeStudentId = await insertStudentDirect(home.academyId, home.branchId, home.creatorUserId);

    // Caller is a member of `home`, so `other.batchId` is out-of-tenant
    // from the caller's own perspective too — resolved before the student
    // check ever runs, but exercises the same "batch not in my academy"
    // path with a same-academy student on the other side of the mismatch.
    const result = await enrollStudentInBatch(home.context, {
      batchId: other.batchId,
      studentId: homeStudentId,
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("enroll/withdraw student — unique-for-active-enrollment enforcement", () => {
  it("enrolling the same student in the same batch twice while active is a conflict", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const first = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(first.ok).toBe(true);

    const second = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });

  it("a withdrawn enrollment allows re-enrollment (new row, not a reactivation)", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const first = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const withdrawn = await withdrawStudentFromBatch(context, first.enrollment.id);
    expect(withdrawn.ok).toBe(true);
    if (withdrawn.ok) expect(withdrawn.enrollment.status).toBe("withdrawn");

    const reenrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(reenrolled.ok).toBe(true);
    if (reenrolled.ok) {
      expect(reenrolled.enrollment.id).not.toBe(first.enrollment.id);
      expect(reenrolled.enrollment.status).toBe("active");
    }

    const rows = await db
      .select()
      .from(batchEnrollments)
      .where(eq(batchEnrollments.studentId, studentId));
    expect(rows.length).toBe(2);
  });

  it("withdrawing an already-withdrawn enrollment returns 'invalid_transition'", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const created = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await withdrawStudentFromBatch(context, created.enrollment.id);
    expect(first.ok).toBe(true);

    const second = await withdrawStudentFromBatch(context, created.enrollment.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("invalid_transition");
  });
});

describe("withdraw reason and listEnrollmentWithdrawals", () => {
  it("records the reason with the withdrawal and reports when and why", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const created = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const before = Date.now();
    const withdrawn = await withdrawStudentFromBatch(context, created.enrollment.id, { reason: "  Moved to another city  " });
    expect(withdrawn.ok).toBe(true);

    const details = await listEnrollmentWithdrawals(context, [created.enrollment.id]);
    const detail = details.get(created.enrollment.id);
    expect(detail?.reason).toBe("Moved to another city");
    expect(detail?.withdrawnAt.getTime()).toBeGreaterThanOrEqual(before - 60_000);
  });

  it("still withdraws without a reason (batch roster) and reports no reason", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const created = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    if (!created.ok) throw new Error("setup failed");

    expect((await withdrawStudentFromBatch(context, created.enrollment.id)).ok).toBe(true);
    const detail = (await listEnrollmentWithdrawals(context, [created.enrollment.id])).get(created.enrollment.id);
    expect(detail).toBeDefined();
    expect(detail?.reason).toBeNull();
  });

  it("rejects an over-long reason without withdrawing", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const created = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    if (!created.ok) throw new Error("setup failed");

    const result = await withdrawStudentFromBatch(context, created.enrollment.id, { reason: "x".repeat(501) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    const [row] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.id, created.enrollment.id));
    expect(row.status).toBe("active");
  });

  it("never reports another academy's withdrawals", async () => {
    const a = await setupAcademy("academy_owner");
    const b = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(a.academyId, a.branchId, a.creatorUserId);
    const created = await enrollStudentInBatch(a.context, { batchId: a.batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    if (!created.ok) throw new Error("setup failed");
    await withdrawStudentFromBatch(a.context, created.enrollment.id, { reason: "Private" });

    const seenByOther = await listEnrollmentWithdrawals(b.context, [created.enrollment.id]);
    expect(seenByOther.size).toBe(0);
  });
});

describe("getAssignedBatchIds", () => {
  it("returns only batches with an ACTIVE trainer assignment for this user+academy", async () => {
    const { academyId, userId, batchId } = await setupAcademy("trainer");
    const staffProfileId = await insertStaffProfile(academyId, userId);
    // Bypass permission gating: insert directly to set up two assignments,
    // one active and one removed, plus a batch with no assignment at all.
    const branchId2 = await insertBranchDirect(academyId);
    const courseId2 = await insertProgramAndCourse(academyId);
    const otherAssignedBatch = await insertBatchDirect(academyId, branchId2, courseId2);
    const unassignedBatch = await insertBatchDirect(academyId, branchId2, courseId2);

    await db
      .insert(batchTrainerAssignments)
      .values({ academyId, batchId, staffProfileId, status: "active" });
    await db
      .insert(batchTrainerAssignments)
      .values({ academyId, batchId: otherAssignedBatch, staffProfileId, status: "removed" });

    const assignedIds = await getAssignedBatchIds(db, userId, academyId);
    expect(assignedIds).toEqual([batchId]);
    expect(assignedIds).not.toContain(otherAssignedBatch);
    expect(assignedIds).not.toContain(unassignedBatch);
  });

  it("returns an empty list for a user with no staff_profiles row", async () => {
    const { academyId } = await setupAcademy("trainer");
    const randomUserId = await createUser();
    const assignedIds = await getAssignedBatchIds(db, randomUserId, academyId);
    expect(assignedIds).toEqual([]);
  });

  it("never crosses academy boundaries — same user, different academy, no leakage", async () => {
    const first = await setupAcademy("trainer");
    const second = await setupAcademy("trainer");
    const staffProfileId = await insertStaffProfile(first.academyId, first.userId);
    await db
      .insert(batchTrainerAssignments)
      .values({ academyId: first.academyId, batchId: first.batchId, staffProfileId, status: "active" });

    const idsInSecondAcademy = await getAssignedBatchIds(db, first.userId, second.academyId);
    expect(idsInSecondAcademy).toEqual([]);
  });

  it("listMyAssignedBatches exposes the same result through the gated wrapper", async () => {
    const { academyId, userId, batchId, context } = await setupAcademy("trainer");
    const staffProfileId = await insertStaffProfile(academyId, userId);
    await db
      .insert(batchTrainerAssignments)
      .values({ academyId, batchId, staffProfileId, status: "active" });

    const result = await listMyAssignedBatches(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.batchIds).toEqual([batchId]);
  });
});

describe("listBatchTrainerAssignments / listBatchEnrollments — branch scoping", () => {
  it("branch-limited role cannot list a batch's roster outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, courseId } = await setupAcademy("trainer");
    const otherBranch = await insertBranchDirect(academyId);
    const assignedBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const outOfScopeBatch = await insertBatchDirect(academyId, otherBranch, courseId);

    const assignmentsResult = await listBatchTrainerAssignments(context, outOfScopeBatch);
    expect(assignmentsResult.ok).toBe(false);
    if (!assignmentsResult.ok) expect(assignmentsResult.error.code).toBe("not_found");

    const enrollmentsResult = await listBatchEnrollments(context, outOfScopeBatch);
    expect(enrollmentsResult.ok).toBe(false);
    if (!enrollmentsResult.ok) expect(enrollmentsResult.error.code).toBe("not_found");
  });

  it("returns 'not_found' (never 'forbidden') for a batch belonging to another academy", async () => {
    const other = await setupAcademy("academy_owner");
    const { context } = await setupAcademy("academy_owner");

    const result = await listBatchTrainerAssignments(context, other.batchId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

// Simple course/enrollment model — the student registration form's
// "Course" select and the `/academy/students` list's "Course" column both
// build on these two functions.

describe("getActiveCoursesForStudents", () => {
  it("returns each student's active-enrollment course/batch names, keyed by studentId", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const otherStudentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const enrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);

    const result = await getActiveCoursesForStudents(academyId, [studentId, otherStudentId]);
    expect(result.get(studentId)).toHaveLength(1);
    expect(result.get(studentId)?.[0].batchId).toBe(batchId);
    expect(result.get(otherStudentId) ?? []).toEqual([]);
  });

  it("excludes withdrawn enrollments", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const enrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    const withdrawn = await withdrawStudentFromBatch(context, enrolled.enrollment.id);
    expect(withdrawn.ok).toBe(true);

    const result = await getActiveCoursesForStudents(academyId, [studentId]);
    expect(result.get(studentId) ?? []).toEqual([]);
  });

  it("returns an empty map for an empty studentIds list", async () => {
    const result = await getActiveCoursesForStudents(randomUUID(), []);
    expect(result.size).toBe(0);
  });
});

describe("updateStudentEnrollment", () => {
  it("enrolls a not-yet-enrolled student into the chosen batch", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await updateStudentEnrollment(context, studentId, batchId, DEFAULT_PAYMENT_PLAN);
    expect(result.ok).toBe(true);

    const active = await getActiveCoursesForStudents(academyId, [studentId]);
    expect(active.get(studentId)?.[0].batchId).toBe(batchId);
  });

  it("adds an enrollment in another batch without withdrawing the first", async () => {
    const { academyId, branchId, courseId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const secondBatchId = await insertBatchDirect(academyId, branchId, courseId);
    await courseOfBatch(secondBatchId);

    const first = await updateStudentEnrollment(context, studentId, batchId, DEFAULT_PAYMENT_PLAN);
    expect(first.ok).toBe(true);

    const second = await updateStudentEnrollment(context, studentId, secondBatchId, DEFAULT_PAYMENT_PLAN);
    expect(second.ok).toBe(true);

    const active = await getActiveCoursesForStudents(academyId, [studentId]);
    expect(active.get(studentId)?.map((c) => c.batchId).sort()).toEqual([batchId, secondBatchId].sort());
  });

  it("refuses without a batch (it never withdraws on its own)", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const enrolled = await updateStudentEnrollment(context, studentId, batchId, DEFAULT_PAYMENT_PLAN);
    expect(enrolled.ok).toBe(true);

    const cleared = await updateStudentEnrollment(context, studentId, undefined);
    expect(cleared.ok).toBe(false);
    if (!cleared.ok) expect(cleared.error.code).toBe("validation");

    const active = await getActiveCoursesForStudents(academyId, [studentId]);
    expect(active.get(studentId)).toHaveLength(1);
  });

  it("refuses a duplicate enrollment in the same batch course", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const first = await updateStudentEnrollment(context, studentId, batchId, DEFAULT_PAYMENT_PLAN);
    expect(first.ok).toBe(true);
    const second = await updateStudentEnrollment(context, studentId, batchId, DEFAULT_PAYMENT_PLAN);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");

    const active = await getActiveCoursesForStudents(academyId, [studentId]);
    expect(active.get(studentId)).toHaveLength(1);
  });
});

describe("enrollStudentInBatch — multi-course batches", () => {
  async function addCourseToBatch(academyId: string, batchId: string): Promise<string> {
    const courseId = await insertProgramAndCourse(academyId);
    await db.insert(batchCourses).values({ academyId, batchId, courseId });
    return courseId;
  }

  it("enrolls one student in two courses of a batch, each with its own fee schedule", async () => {
    const { academyId, branchId, courseId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const secondCourseId = await addCourseToBatch(academyId, batchId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      courseIds: [courseId, secondCourseId],
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enrollments.map((e) => e.courseId).sort()).toEqual([courseId, secondCourseId].sort());

    const schedules = await db
      .select({ enrollmentId: enrollmentFeeSchedules.enrollmentId })
      .from(enrollmentFeeSchedules)
      .where(inArray(enrollmentFeeSchedules.enrollmentId, result.enrollments.map((e) => e.id)));
    expect(schedules).toHaveLength(2);

    const students = await db.select({ id: batchEnrollments.studentId }).from(batchEnrollments).where(eq(batchEnrollments.batchId, batchId));
    expect(new Set(students.map((row) => row.id))).toEqual(new Set([studentId]));
  });

  it("requires a course choice when the batch runs several courses", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    await addCourseToBatch(academyId, batchId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects a course that isn't part of the batch, and writes nothing", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const outsideCourseId = await insertProgramAndCourse(academyId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      courseIds: [outsideCourseId],
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    const rows = await db.select({ id: batchEnrollments.id }).from(batchEnrollments).where(eq(batchEnrollments.studentId, studentId));
    expect(rows).toHaveLength(0);
  });

  it("rejects another academy's course even when named explicitly", async () => {
    const { batchId, academyId, branchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const other = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      courseIds: [other.courseId],
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(result.ok).toBe(false);
  });

  it("rolls back every course when one of them is already enrolled", async () => {
    const { academyId, branchId, courseId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const secondCourseId = await addCourseToBatch(academyId, batchId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const first = await enrollStudentInBatch(context, { batchId, studentId, courseIds: [courseId], paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(first.ok).toBe(true);
    const both = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      courseIds: [courseId, secondCourseId],
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error.code).toBe("conflict");

    const rows = await db
      .select({ courseId: batchEnrollments.courseId })
      .from(batchEnrollments)
      .where(and(eq(batchEnrollments.studentId, studentId), eq(batchEnrollments.status, "active")));
    expect(rows.map((row) => row.courseId)).toEqual([courseId]);
  });
});
