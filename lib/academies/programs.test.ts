import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
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
import {
  archiveProgram,
  createProgram,
  deleteProgram,
  getProgram,
  getProgramDeletionEligibility,
  listPrograms,
  updateProgram,
  type CreateProgramInput,
} from "./programs";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `programs-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Programs Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
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
      name: `Programs Test Academy ${randomUUID()}`,
      slug: `programs-test-${randomUUID()}`,
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

async function setupAcademy(
  role: AcademyRole,
): Promise<{ academyId: string; userId: string; context: AuthContext }> {
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

  return { academyId, userId, context: { userId, branchIds: [], academyWide: false } };
}

async function insertProgramDirect(academyId: string, name = `Program ${randomUUID()}`): Promise<string> {
  const [row] = await db
    .insert(programs)
    .values({ academyId, name })
    .returning({ id: programs.id });
  return row.id;
}

function validInput(overrides: Partial<CreateProgramInput> = {}): CreateProgramInput {
  return {
    name: `Test Program ${randomUUID()}`,
    description: "A test program",
    ...overrides,
  };
}

async function insertCourseDirect(academyId: string, programId: string): Promise<string> {
  const [row] = await db
    .insert(courses)
    .values({ academyId, programId, name: `Course ${randomUUID()}` })
    .returning({ id: courses.id });
  return row.id;
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

describe("createProgram — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: create allowed = %s", async (role, allowed) => {
    const { context } = await setupAcademy(role);
    const result = await createProgram(context, validInput());
    expect(result.ok).toBe(allowed);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("writes an audit row on successful creation", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const result = await createProgram(context, validInput({ name: "Audited Program" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, result.program.id));
    expect(audit?.action).toBe("createProgram");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("rejects an empty name with code 'validation'", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await createProgram(context, validInput({ name: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects a duplicate program name within the same academy with code 'conflict'", async () => {
    const { context } = await setupAcademy("academy_owner");
    const first = await createProgram(context, validInput({ name: "Same Name" }));
    expect(first.ok).toBe(true);

    const second = await createProgram(context, validInput({ name: "Same Name" }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });
});

describe("archiveProgram — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: archive allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const programId = await insertProgramDirect(owner.academyId);

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const result = await archiveProgram(actingContext, programId);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("is idempotent on an already-archived program", async () => {
    const { context } = await setupAcademy("academy_owner");
    const created = await createProgram(context, validInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await archiveProgram(context, created.program.id);
    expect(first.ok).toBe(true);
    const second = await archiveProgram(context, created.program.id);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.program.status).toBe("archived");
  });
});

describe("updateProgram", () => {
  it("allows a manager to rename a program", async () => {
    const { context } = await setupAcademy("manager");
    const created = await createProgram(context, validInput({ name: "Original" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await updateProgram(context, created.program.id, validInput({ name: "Renamed" }));
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.program.name).toBe("Renamed");
  });
});

describe("listPrograms / getProgram", () => {
  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager", "admissions_officer", "trainer"])(
    "role %s can list academy-wide programs (no branch scoping)",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const programId = await insertProgramDirect(academyId);

      const result = await listPrograms(context);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.programs.map((p) => p.id)).toContain(programId);
      }
    },
  );

  it("finance_officer is refused entirely with code 'forbidden'", async () => {
    const { academyId, context } = await setupAcademy("finance_officer");
    await insertProgramDirect(academyId);

    const result = await listPrograms(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("never returns another academy's programs", async () => {
    const other = await setupAcademy("academy_owner");
    await insertProgramDirect(other.academyId);

    const { context } = await setupAcademy("academy_owner");
    const result = await listPrograms(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.programs).toEqual([]);
  });

  it("getProgram returns 'not_found' (never 'forbidden') for a cross-academy program", async () => {
    const other = await setupAcademy("academy_owner");
    const otherProgramId = await insertProgramDirect(other.academyId);

    const { context } = await setupAcademy("academy_owner");
    const result = await getProgram(context, otherProgramId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("getProgramDeletionEligibility / deleteProgram", () => {
  it("an unused program (zero courses) is eligible and deletes", async () => {
    const { context } = await setupAcademy("academy_owner");
    const created = await createProgram(context, validInput({ name: "Unused Program" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const eligibility = await getProgramDeletionEligibility(context, created.program.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(true);
      expect(eligibility.eligibility.reasons).toEqual([]);
    }

    const deleted = await deleteProgram(context, created.program.id, "Unused Program");
    expect(deleted.ok).toBe(true);

    const stillThere = await getProgram(context, created.program.id);
    expect(stillThere.ok).toBe(false);
    if (!stillThere.ok) expect(stillThere.error.code).toBe("not_found");
  });

  it("a program with a course attached is blocked from deletion, and nothing is deleted", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const created = await createProgram(context, validInput({ name: "Program With Courses" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await insertCourseDirect(academyId, created.program.id);

    const eligibility = await getProgramDeletionEligibility(context, created.program.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.courseCount).toBe(1);
    }

    const deleted = await deleteProgram(context, created.program.id, "Program With Courses");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");

    const stillThere = await getProgram(context, created.program.id);
    expect(stillThere.ok).toBe(true);
  });

  it("rejects a wrong confirmation name, and nothing is deleted", async () => {
    const { context } = await setupAcademy("academy_owner");
    const created = await createProgram(context, validInput({ name: "Type Me Exactly" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await deleteProgram(context, created.program.id, "Wrong Name");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const stillThere = await getProgram(context, created.program.id);
    expect(stillThere.ok).toBe(true);
  });

  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const owner = await setupAcademy("academy_owner");
      const created = await createProgram(owner.context, validInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const actingUserId = await createUser();
      await addMembership(actingUserId, owner.academyId, role);
      const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

      const result = await deleteProgram(actingContext, created.program.id, created.program.name);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("never deletes another academy's program (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherCreated = await createProgram(other.context, validInput({ name: "Other Academy Program" }));
    expect(otherCreated.ok).toBe(true);
    if (!otherCreated.ok) return;

    const { context } = await setupAcademy("academy_owner");
    const eligibility = await getProgramDeletionEligibility(context, otherCreated.program.id);
    expect(eligibility.ok).toBe(false);
    if (!eligibility.ok) expect(eligibility.error.code).toBe("not_found");

    const result = await deleteProgram(context, otherCreated.program.id, "Other Academy Program");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const stillThere = await getProgram(other.context, otherCreated.program.id);
    expect(stillThere.ok).toBe(true);
  });

  it("writes an audit row before deleting, and the audit row survives the deletion", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const created = await createProgram(context, validInput({ name: "Audited Deletion" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await deleteProgram(context, created.program.id, "Audited Deletion");
    expect(result.ok).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.program.id), eq(auditLogs.action, "deleteProgram")));
    expect(audit?.action).toBe("deleteProgram");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("race condition: a course created after the eligibility check still blocks the delete transaction", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const created = await createProgram(context, validInput({ name: "Race Condition Program" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const eligibility = await getProgramDeletionEligibility(context, created.program.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) expect(eligibility.eligibility.eligible).toBe(true);

    // Simulates a concurrent createCourse landing between the UI's
    // eligibility preview and the actual delete call.
    await insertCourseDirect(academyId, created.program.id);

    const result = await deleteProgram(context, created.program.id, "Race Condition Program");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");

    const stillThere = await getProgram(context, created.program.id);
    expect(stillThere.ok).toBe(true);
  });
});
