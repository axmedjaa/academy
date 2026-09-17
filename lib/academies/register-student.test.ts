import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  branches,
  staffBranchAssignments,
  staffProfiles,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  generateStudentId,
  registerStudent,
  type RegisterStudentInput,
} from "./register-student";

const DAY_MS = 24 * 60 * 60 * 1000;

// Same "one top-level cleanup, every test builds its own fully isolated
// fixture set" convention as lib/academies/branches.test.ts / staff.test.ts.
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `register-student-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(maxStudents = 100): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Register Student Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 10,
      maxStudents,
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
      name: `Register Student Test Academy ${randomUUID()}`,
      slug: `register-student-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(
  userId: string,
  academyId: string,
  role: AcademyRole,
): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

async function insertBranchDirect(
  academyId: string,
  code = `BR-${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${code}`, code })
    .returning({ id: branches.id });
  return row.id;
}

/** Same fixture helper as lib/academies/branches.test.ts's
 * assignUserToBranches — bypasses not-yet-built staff create/branch
 * assignment actions per that file's own documented convention. */
async function assignUserToBranches(
  academyId: string,
  userId: string,
  branchIds: string[],
): Promise<void> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({
      academyId,
      userId,
      fullName: "Test Staff Member",
      phone: "+1-555-0100",
    })
    .returning({ id: staffProfiles.id });

  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({
      academyId,
      staffProfileId: profile.id,
      branchId,
    });
  }
}

/** Full fixture: a fresh academy, one active plan/subscription (default
 * 100 students allowed), one branch, and one membership of the given
 * role. */
async function setupAcademy(
  role: AcademyRole,
  maxStudents = 100,
): Promise<{
  academyId: string;
  branchId: string;
  userId: string;
  context: AuthContext;
}> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan(maxStudents);
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    endsAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: creatorUserId,
  });
  const branchId = await insertBranchDirect(academyId);

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  return {
    academyId,
    branchId,
    userId,
    context: { userId, branchIds: [], academyWide: false },
  };
}

function validInput(branchId: string, overrides: Partial<RegisterStudentInput> = {}): RegisterStudentInput {
  return {
    branchId,
    fullName: `Test Student ${randomUUID()}`,
    dateOfBirth: "2005-01-01",
    gender: "female",
    phone: "+1-555-0177",
    email: "",
    guardianName: "Guardian Name",
    guardianPhone: "+1-555-0188",
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
    await db.delete(students).where(eq(students.academyId, academyId));
    const profiles = await db
      .select({ id: staffProfiles.id })
      .from(staffProfiles)
      .where(eq(staffProfiles.academyId, academyId));
    for (const profile of profiles) {
      await db
        .delete(staffBranchAssignments)
        .where(eq(staffBranchAssignments.staffProfileId, profile.id));
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

describe("registerStudent — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", true],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: register allowed = %s", async (role, allowed) => {
    const { academyId, branchId, userId, context } = await setupAcademy(role);

    // Admissions Officer is branch-limited (§6) — give it an assignment to
    // the fixture branch so this test isolates the role-level permission
    // question from the separate branch-scoping tests below.
    if (role === "admissions_officer") {
      await assignUserToBranches(academyId, userId, [branchId]);
    }

    const result = await registerStudent(context, validInput(branchId));
    expect(result.ok).toBe(allowed);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("writes an audit row on successful registration", async () => {
    const { academyId, branchId, userId, context } = await setupAcademy("academy_owner");
    const result = await registerStudent(context, validInput(branchId, { fullName: "Audited Student" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.student.id));
    expect(audit?.action).toBe("registerStudent");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
    expect(audit?.branchId).toBe(branchId);
  });

  it("rejects an empty full name with code 'validation'", async () => {
    const { branchId, context } = await setupAcademy("academy_owner");
    const result = await registerStudent(context, validInput(branchId, { fullName: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("auto-generates the student number — the caller can never supply one", async () => {
    const { branchId, context } = await setupAcademy("academy_owner");
    const result = await registerStudent(context, validInput(branchId));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.student.studentNumber).toMatch(/^STD-\d{6}$/);
    }
  });
});

describe("registerStudent — branch-limited scoping (Admissions Officer)", () => {
  it("Admissions Officer can register into an assigned branch", async () => {
    const { academyId, branchId, userId, context } = await setupAcademy("admissions_officer");
    await assignUserToBranches(academyId, userId, [branchId]);

    const result = await registerStudent(context, validInput(branchId));
    expect(result.ok).toBe(true);
  });

  it("Admissions Officer is refused (code 'not_found') for an unassigned branch, IDOR-safe", async () => {
    const { academyId, branchId: assignedBranch, userId, context } = await setupAcademy(
      "admissions_officer",
    );
    const otherBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);

    const result = await registerStudent(context, validInput(otherBranch));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("Admissions Officer with no staff_profiles/assignment rows is refused for any branch", async () => {
    const { branchId, context } = await setupAcademy("admissions_officer");
    const result = await registerStudent(context, validInput(branchId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("academy-wide roles (Manager) may register into any branch of the academy, unfiltered by assignment", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const anotherBranch = await insertBranchDirect(academyId);

    const result = await registerStudent(context, validInput(anotherBranch));
    expect(result.ok).toBe(true);
  });
});

describe("registerStudent — tenant isolation", () => {
  it("rejects a branchId belonging to another academy with code 'not_found'", async () => {
    const other = await setupAcademy("academy_owner");
    const { context } = await setupAcademy("academy_owner");

    const result = await registerStudent(context, validInput(other.branchId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("registerStudent — cross-tenant student-ID independence", () => {
  it("two different academies can both register STD-000001", async () => {
    const academyA = await setupAcademy("academy_owner");
    const academyB = await setupAcademy("academy_owner");

    const resultA = await registerStudent(academyA.context, validInput(academyA.branchId));
    const resultB = await registerStudent(academyB.context, validInput(academyB.branchId));

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (resultA.ok && resultB.ok) {
      expect(resultA.student.studentNumber).toBe("STD-000001");
      expect(resultB.student.studentNumber).toBe("STD-000001");
      expect(resultA.student.academyId).not.toBe(resultB.student.academyId);
    }
  });
});

describe("students(academy_id, student_number) — DB-level uniqueness (duplicate within one academy)", () => {
  it("rejects a duplicate student_number for the same academy at the DB level", async () => {
    const { academyId, branchId, userId } = await setupAcademy("academy_owner");

    await db.insert(students).values({
      academyId,
      branchId,
      studentNumber: "STD-000001",
      fullName: "First Student",
      createdBy: userId,
    });

    await expect(
      db.insert(students).values({
        academyId,
        branchId,
        studentNumber: "STD-000001",
        fullName: "Duplicate Student",
        createdBy: userId,
      }),
    ).rejects.toBeTruthy();
  });

  it("the same student_number IS allowed across two different academies", async () => {
    const first = await setupAcademy("academy_owner");
    const second = await setupAcademy("academy_owner");

    await db.insert(students).values({
      academyId: first.academyId,
      branchId: first.branchId,
      studentNumber: "STD-000001",
      fullName: "Academy A Student",
      createdBy: first.userId,
    });

    await expect(
      db.insert(students).values({
        academyId: second.academyId,
        branchId: second.branchId,
        studentNumber: "STD-000001",
        fullName: "Academy B Student",
        createdBy: second.userId,
      }),
    ).resolves.toBeDefined();
  });
});

describe("checkAllowance('students') — hard block at plan limit", () => {
  it("allows registration up to the plan limit and hard-blocks the next one", async () => {
    const { branchId, context } = await setupAcademy("academy_owner", 1);

    const first = await registerStudent(context, validInput(branchId));
    expect(first.ok).toBe(true);

    const second = await registerStudent(context, validInput(branchId));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("allowance");
      expect(second.error.message).toMatch(/limit/i);
    }
  });

  it("archiving a student frees the allowance slot for a new one", async () => {
    const { branchId, context } = await setupAcademy("academy_owner", 1);

    const first = await registerStudent(context, validInput(branchId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const blocked = await registerStudent(context, validInput(branchId));
    expect(blocked.ok).toBe(false);

    await db
      .update(students)
      .set({ status: "archived" })
      .where(eq(students.id, first.student.id));

    const afterArchive = await registerStudent(context, validInput(branchId));
    expect(afterArchive.ok).toBe(true);
  });
});

describe("generateStudentId", () => {
  it("returns STD-000001 for a brand-new academy with no students yet", async () => {
    const { academyId } = await setupAcademy("academy_owner");
    const id = await generateStudentId(db, academyId);
    expect(id).toBe("STD-000001");
  });

  it("counts existing students and returns the next sequential number", async () => {
    const { academyId, branchId, userId } = await setupAcademy("academy_owner");
    await db.insert(students).values({
      academyId,
      branchId,
      studentNumber: "STD-000001",
      fullName: "Existing Student",
      createdBy: userId,
    });

    const id = await generateStudentId(db, academyId);
    expect(id).toBe("STD-000002");
  });

  it("skips a candidate number that is already taken (retry-on-conflict scan), never a racy count alone", async () => {
    const { academyId, branchId, userId } = await setupAcademy("academy_owner");
    // Only one real row exists (count = 1, so the naive "count + 1"
    // candidate would be STD-000002) but that exact candidate number is
    // already taken — simulating the kind of gap a racy `SELECT MAX(...) +
    // 1` scheme could produce. generateStudentId must scan past it rather
    // than returning a colliding id.
    await db.insert(students).values({
      academyId,
      branchId,
      studentNumber: "STD-000002",
      fullName: "Out-of-order Student",
      createdBy: userId,
    });

    const id = await generateStudentId(db, academyId);
    expect(id).toBe("STD-000003");
  });

  it("concurrent registerStudent calls in the same academy never collide — a losing race retries onto a fresh number", async () => {
    const { branchId, context } = await setupAcademy("academy_owner", 50);

    // 8-way concurrency (not just 2) to make an actual DB-level
    // (academy_id, student_number) unique-violation race likely to occur
    // in practice, not just be theoretically possible — exercising the
    // fresh-transaction-per-attempt retry loop for real rather than
    // relying on all 8 calls happening to serialize cleanly.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => registerStudent(context, validInput(branchId))),
    );

    for (const result of results) {
      expect(result.ok).toBe(true);
    }
    const numbers = results.flatMap((r) => (r.ok ? [r.student.studentNumber] : []));
    expect(new Set(numbers).size).toBe(8);
    expect(numbers.slice().sort()).toEqual([
      "STD-000001",
      "STD-000002",
      "STD-000003",
      "STD-000004",
      "STD-000005",
      "STD-000006",
      "STD-000007",
      "STD-000008",
    ]);
  });
});
