import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batches,
  branches,
  courses,
  programs,
  staffBranchAssignments,
  staffProfiles,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  archiveBatch,
  createBatch,
  getBatch,
  listBatches,
  updateBatch,
  type CreateBatchInput,
} from "./batches";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `batches-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Batches Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 10,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  createdPlanIds.push(plan.id);
  return plan.id;
}

async function createAcademy(creatorUserId: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Batches Test Academy ${randomUUID()}`,
      slug: `batches-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(userId: string, academyId: string, role: AcademyRole): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

async function insertBranchDirect(academyId: string): Promise<string> {
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` })
    .returning({ id: branches.id });
  return row.id;
}

async function insertProgramAndCourse(academyId: string): Promise<string> {
  const [program] = await db
    .insert(programs)
    .values({ academyId, name: `Program ${randomUUID()}` })
    .returning({ id: programs.id });
  const [course] = await db
    .insert(courses)
    .values({ academyId, programId: program.id, name: `Course ${randomUUID()}` })
    .returning({ id: courses.id });
  return course.id;
}

async function assignUserToBranches(academyId: string, userId: string, branchIds: string[]): Promise<void> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Test Staff Member", phone: "+1-555-0100" })
    .returning({ id: staffProfiles.id });

  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({ academyId, staffProfileId: profile.id, branchId });
  }
}

async function setupAcademy(
  role: AcademyRole,
): Promise<{
  academyId: string;
  userId: string;
  branchId: string;
  courseId: string;
  context: AuthContext;
}> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan();
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    endsAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: creatorUserId,
  });

  const userId = await createUser();
  await addMembership(userId, academyId, role);
  const branchId = await insertBranchDirect(academyId);
  const courseId = await insertProgramAndCourse(academyId);

  return { academyId, userId, branchId, courseId, context: { userId, branchIds: [], academyWide: false } };
}

function validInput(
  branchId: string,
  courseId: string,
  overrides: Partial<CreateBatchInput> = {},
): CreateBatchInput {
  return {
    branchId,
    courseId,
    name: `Test Batch ${randomUUID()}`,
    code: `B-${randomUUID().slice(0, 8)}`,
    startDate: "2026-01-15",
    ...overrides,
  };
}

afterAll(async () => {
  await db
    .delete(auditLogs)
    .where(
      or(
        ...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)),
        ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id)),
      ),
    );
  for (const academyId of createdAcademyIds) {
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    const profiles = await db
      .select({ id: staffProfiles.id })
      .from(staffProfiles)
      .where(eq(staffProfiles.academyId, academyId));
    for (const profile of profiles) {
      await db.delete(staffBranchAssignments).where(eq(staffBranchAssignments.staffProfileId, profile.id));
    }
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
  }
  for (const academyId of createdAcademyIds) {
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("createBatch — permission matrix (academy-wide roles, own branch)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["finance_officer", false],
  ])("role %s: create allowed = %s", async (role, allowed) => {
    const { context, branchId, courseId } = await setupAcademy(role);
    const result = await createBatch(context, validInput(branchId, courseId));
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("admissions_officer ('view') is refused create even for its own assigned branch", async () => {
    const { academyId, userId, context, branchId, courseId } = await setupAcademy("admissions_officer");
    await assignUserToBranches(academyId, userId, [branchId]);

    const result = await createBatch(context, validInput(branchId, courseId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("trainer ('manage assigned') can create a batch in their own assigned branch", async () => {
    const { academyId, userId, context, branchId, courseId } = await setupAcademy("trainer");
    await assignUserToBranches(academyId, userId, [branchId]);

    const result = await createBatch(context, validInput(branchId, courseId));
    expect(result.ok).toBe(true);
  });

  it("trainer cannot create a batch in a branch they are not assigned to (IDOR)", async () => {
    const { academyId, userId, context, courseId } = await setupAcademy("trainer");
    const otherBranch = await insertBranchDirect(academyId);
    const assignedBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);

    const result = await createBatch(context, validInput(otherBranch, courseId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("writes an audit row on successful creation", async () => {
    const { academyId, userId, context, branchId, courseId } = await setupAcademy("academy_owner");
    const result = await createBatch(context, validInput(branchId, courseId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, result.batch.id));
    expect(audit?.action).toBe("createBatch");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("rejects a nonexistent courseId with code 'not_found'", async () => {
    const { context, branchId } = await setupAcademy("academy_owner");
    const result = await createBatch(context, validInput(branchId, randomUUID()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent branchId with code 'not_found'", async () => {
    const { context, courseId } = await setupAcademy("academy_owner");
    const result = await createBatch(context, validInput(randomUUID(), courseId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a duplicate batch code within the same academy with code 'conflict'", async () => {
    const { context, branchId, courseId } = await setupAcademy("academy_owner");
    const first = await createBatch(context, validInput(branchId, courseId, { code: "DUPBATCH" }));
    expect(first.ok).toBe(true);

    const second = await createBatch(context, validInput(branchId, courseId, { code: "DUPBATCH" }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });
});

describe("listBatches / getBatch — branch-scoped roles (Admissions Officer, Trainer)", () => {
  it.each<AcademyRole>(["admissions_officer", "trainer"])(
    "role %s sees only batches in their assigned branch(es)",
    async (role) => {
      const { academyId, userId, context, courseId } = await setupAcademy(role);
      const assignedBranch = await insertBranchDirect(academyId);
      const otherBranch = await insertBranchDirect(academyId);
      await assignUserToBranches(academyId, userId, [assignedBranch]);

      const [visibleBatch] = await db
        .insert(batches)
        .values({
          academyId,
          branchId: assignedBranch,
          courseId,
          name: "Visible Batch",
          code: `VB-${randomUUID().slice(0, 6)}`,
          startDate: "2026-01-01",
        })
        .returning({ id: batches.id });
      const [hiddenBatch] = await db
        .insert(batches)
        .values({
          academyId,
          branchId: otherBranch,
          courseId,
          name: "Hidden Batch",
          code: `HB-${randomUUID().slice(0, 6)}`,
          startDate: "2026-01-01",
        })
        .returning({ id: batches.id });

      const result = await listBatches(context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.batches.map((b) => b.id)).toEqual([visibleBatch.id]);

      const okGet = await getBatch(context, visibleBatch.id);
      expect(okGet.ok).toBe(true);

      const idorGet = await getBatch(context, hiddenBatch.id);
      expect(idorGet.ok).toBe(false);
      if (!idorGet.ok) expect(idorGet.error.code).toBe("not_found");
    },
  );

  it.each<AcademyRole>(["admissions_officer", "trainer"])(
    "role %s: getBatch on a guessed/nonexistent id returns the identical 'not_found'",
    async (role) => {
      const { academyId, userId, context, branchId } = await setupAcademy(role);
      await assignUserToBranches(academyId, userId, [branchId]);

      const guessed = await getBatch(context, randomUUID());
      expect(guessed.ok).toBe(false);
      if (!guessed.ok) expect(guessed.error.code).toBe("not_found");
    },
  );

  it("academy-wide roles (owner/admin/manager) see every batch, unfiltered by branch", async () => {
    const { academyId, context, courseId } = await setupAcademy("academy_owner");
    const branchA = await insertBranchDirect(academyId);
    const branchB = await insertBranchDirect(academyId);
    const [a] = await db
      .insert(batches)
      .values({ academyId, branchId: branchA, courseId, name: "A", code: `A-${randomUUID().slice(0, 6)}`, startDate: "2026-01-01" })
      .returning({ id: batches.id });
    const [b] = await db
      .insert(batches)
      .values({ academyId, branchId: branchB, courseId, name: "B", code: `B-${randomUUID().slice(0, 6)}`, startDate: "2026-01-01" })
      .returning({ id: batches.id });

    const result = await listBatches(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batches.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("updateBatch / archiveBatch — branch scoping", () => {
  it("trainer cannot update or archive a batch outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, courseId } = await setupAcademy("trainer");
    const assignedBranch = await insertBranchDirect(academyId);
    const otherBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);

    const [otherBatch] = await db
      .insert(batches)
      .values({
        academyId,
        branchId: otherBranch,
        courseId,
        name: "Other Branch Batch",
        code: `OB-${randomUUID().slice(0, 6)}`,
        startDate: "2026-01-01",
      })
      .returning({ id: batches.id });

    const updateResult = await updateBatch(context, otherBatch.id, validInput(otherBranch, courseId));
    expect(updateResult.ok).toBe(false);
    if (!updateResult.ok) expect(updateResult.error.code).toBe("not_found");

    const archiveResult = await archiveBatch(context, otherBatch.id);
    expect(archiveResult.ok).toBe(false);
    if (!archiveResult.ok) expect(archiveResult.error.code).toBe("not_found");
  });

  it("trainer can update/archive a batch inside their assigned branch", async () => {
    const { academyId, userId, context, branchId, courseId } = await setupAcademy("trainer");
    await assignUserToBranches(academyId, userId, [branchId]);

    const created = await createBatch(context, validInput(branchId, courseId));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await updateBatch(
      context,
      created.batch.id,
      validInput(branchId, courseId, { name: "Updated Name" }),
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.batch.name).toBe("Updated Name");

    const archived = await archiveBatch(context, created.batch.id);
    expect(archived.ok).toBe(true);
    if (archived.ok) expect(archived.batch.status).toBe("archived");
  });
});

describe("tenant isolation — cross-academy access", () => {
  it("getBatch returns 'not_found' (never 'forbidden') for a batch belonging to another academy", async () => {
    const other = await setupAcademy("academy_owner");
    const otherBatch = await createBatch(other.context, validInput(other.branchId, other.courseId));
    expect(otherBatch.ok).toBe(true);
    if (!otherBatch.ok) return;

    const { context } = await setupAcademy("academy_owner");
    const result = await getBatch(context, otherBatch.batch.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});
