import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  courses,
  programs,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { archiveCourse, createCourse, listCourses, updateCourse, type CreateCourseInput } from "./courses";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `courses-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(maxCourses = 5): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Courses Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses,
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
      name: `Courses Test Academy ${randomUUID()}`,
      slug: `courses-test-${randomUUID()}`,
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

async function insertProgramDirect(academyId: string): Promise<string> {
  const [row] = await db
    .insert(programs)
    .values({ academyId, name: `Program ${randomUUID()}` })
    .returning({ id: programs.id });
  return row.id;
}

async function setupAcademy(
  role: AcademyRole,
  maxCourses = 5,
): Promise<{ academyId: string; userId: string; programId: string; context: AuthContext }> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan(maxCourses);
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    endsAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: creatorUserId,
  });

  const userId = await createUser();
  await addMembership(userId, academyId, role);
  const programId = await insertProgramDirect(academyId);

  return { academyId, userId, programId, context: { userId, branchIds: [], academyWide: false } };
}

function validInput(programId: string, overrides: Partial<CreateCourseInput> = {}): CreateCourseInput {
  return {
    programId,
    name: `Test Course ${randomUUID()}`,
    code: `C-${randomUUID().slice(0, 6)}`,
    description: "A test course",
    durationWeeks: 8,
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
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
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

describe("createCourse — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: create allowed = %s", async (role, allowed) => {
    const { context, programId } = await setupAcademy(role);
    const result = await createCourse(context, validInput(programId));
    expect(result.ok).toBe(allowed);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("writes an audit row on successful creation", async () => {
    const { academyId, userId, programId, context } = await setupAcademy("academy_owner");
    const result = await createCourse(context, validInput(programId, { name: "Audited Course" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, result.course.id));
    expect(audit?.action).toBe("createCourse");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("rejects a nonexistent programId with code 'not_found'", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await createCourse(context, validInput(randomUUID()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a cross-academy programId with code 'not_found' (never 'forbidden')", async () => {
    const other = await setupAcademy("academy_owner");
    const { context } = await setupAcademy("academy_owner");
    const result = await createCourse(context, validInput(other.programId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a duplicate course name within the same academy with code 'conflict'", async () => {
    const { context, programId } = await setupAcademy("academy_owner");
    const first = await createCourse(context, validInput(programId, { name: "Same Course Name" }));
    expect(first.ok).toBe(true);

    const second = await createCourse(context, validInput(programId, { name: "Same Course Name" }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });
});

describe("checkAllowance('courses') — hard block at plan limit", () => {
  it("allows creation up to the plan limit and hard-blocks the next one", async () => {
    const { context, programId } = await setupAcademy("academy_owner", 1);

    const first = await createCourse(context, validInput(programId));
    expect(first.ok).toBe(true);

    const second = await createCourse(context, validInput(programId));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("allowance");
      expect(second.error.message).toMatch(/limit/i);
    }
  });

  it("archiving a course frees the allowance slot for a new one", async () => {
    const { context, programId } = await setupAcademy("academy_owner", 1);

    const first = await createCourse(context, validInput(programId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const blocked = await createCourse(context, validInput(programId));
    expect(blocked.ok).toBe(false);

    const archived = await archiveCourse(context, first.course.id);
    expect(archived.ok).toBe(true);
    if (archived.ok) expect(archived.course.status).toBe("archived");

    const afterArchive = await createCourse(context, validInput(programId));
    expect(afterArchive.ok).toBe(true);
  });
});

describe("archiveCourse / updateCourse — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: update/archive allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const created = await createCourse(owner.context, validInput(owner.programId));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const updateResult = await updateCourse(
      actingContext,
      created.course.id,
      validInput(owner.programId, { name: "Renamed Course" }),
    );
    expect(updateResult.ok).toBe(allowed);
    if (!updateResult.ok) expect(updateResult.error.code).toBe("forbidden");

    const archiveResult = await archiveCourse(actingContext, created.course.id);
    expect(archiveResult.ok).toBe(allowed);
    if (!archiveResult.ok) expect(archiveResult.error.code).toBe("forbidden");
  });
});

describe("listCourses — tenant isolation", () => {
  it("never returns another academy's courses", async () => {
    const other = await setupAcademy("academy_owner");
    await createCourse(other.context, validInput(other.programId));

    const { context } = await setupAcademy("academy_owner");
    const result = await listCourses(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.courses).toEqual([]);
  });
});
