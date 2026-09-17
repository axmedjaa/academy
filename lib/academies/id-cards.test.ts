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
  studentIdCards,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  generateCardNumber,
  getIdCard,
  issueStudentIdCard,
  reprintStudentIdCard,
} from "./id-cards";

const DAY_MS = 24 * 60 * 60 * 1000;

// Same "one top-level cleanup, every test builds its own fully isolated
// fixture set" convention as lib/academies/branches.test.ts.
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `id-cards-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `ID Cards Test Plan ${randomUUID()}`,
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
      name: `ID Cards Test Academy ${randomUUID()}`,
      slug: `id-cards-test-${randomUUID()}`,
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

async function insertBranchDirect(academyId: string): Promise<string> {
  const code = `BR-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${code}`, code })
    .returning({ id: branches.id });
  return row.id;
}

/** Directly inserts a students row — Item 38's registerStudent may not be
 * built yet, so tests build this fixture data directly, per the task
 * brief. */
async function insertStudentDirect(
  academyId: string,
  branchId: string,
  creatorUserId: string,
): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({
      academyId,
      branchId,
      studentNumber: `STD-${randomUUID().slice(0, 8)}`,
      fullName: "Test Student",
      createdBy: creatorUserId,
    })
    .returning({ id: students.id });
  return row.id;
}

/** Directly inserts staff_profiles + staff_branch_assignments rows, same
 * bypass convention as lib/academies/branches.test.ts's
 * assignUserToBranches. */
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

/** Full fixture: a fresh academy, one active plan/subscription, a
 * membership of the given role, one branch, and one student in that
 * branch. Branch-limited roles (admissions_officer, trainer) are assigned
 * to the student's own branch by default — pass `assignToBranch: false`
 * for the IDOR variant that needs the caller assigned elsewhere. */
async function setupWithStudent(
  role: AcademyRole,
  options: { assignToBranch?: boolean } = {},
): Promise<{
  academyId: string;
  userId: string;
  context: AuthContext;
  branchId: string;
  otherBranchId: string;
  studentId: string;
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

  const branchId = await insertBranchDirect(academyId);
  const otherBranchId = await insertBranchDirect(academyId);
  const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  const assignToBranch = options.assignToBranch ?? true;
  if ((role === "admissions_officer" || role === "trainer") && assignToBranch) {
    await assignUserToBranches(academyId, userId, [branchId]);
  }

  return {
    academyId,
    userId,
    context: { userId, branchIds: [], academyWide: false },
    branchId,
    otherBranchId,
    studentId,
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
    await db.delete(studentIdCards).where(eq(studentIdCards.academyId, academyId));
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
    await db.delete(students).where(eq(students.academyId, academyId));
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

describe("issueStudentIdCard — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", true],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: issue allowed = %s", async (role, allowed) => {
    const { context, studentId } = await setupWithStudent(role);
    const result = await issueStudentIdCard(context, { studentId });
    expect(result.ok).toBe(allowed);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("generates a card_number, stamps issued_at/issued_by, and defaults reprint_count to 0", async () => {
    const before = new Date();
    const { context, userId, studentId } = await setupWithStudent("academy_owner");
    const result = await issueStudentIdCard(context, { studentId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.card.cardNumber).toMatch(/^IDC-[A-Z0-9]{10}$/);
    expect(result.card.issuedBy).toBe(userId);
    expect(result.card.issuedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.card.reprintCount).toBe(0);
    expect(result.card.status).toBe("active");
  });

  it("generates a different card_number on each issuance for the same student", async () => {
    const { context, studentId } = await setupWithStudent("academy_owner");
    const first = await issueStudentIdCard(context, { studentId });
    const second = await issueStudentIdCard(context, { studentId });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.card.cardNumber).not.toBe(second.card.cardNumber);
  });

  it("generateCardNumber produces well-formed, non-colliding output across many calls", () => {
    const numbers = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const value = generateCardNumber();
      expect(value).toMatch(/^IDC-[A-Z0-9]{10}$/);
      numbers.add(value);
    }
    expect(numbers.size).toBe(500);
  });

  it("writes an audit row on successful issuance", async () => {
    const { academyId, userId, context, studentId } = await setupWithStudent("academy_owner");
    const result = await issueStudentIdCard(context, { studentId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.card.id));
    expect(audit?.action).toBe("issueStudentIdCard");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("rejects a nonexistent student id with 'not_found'", async () => {
    const { context } = await setupWithStudent("academy_owner");
    const result = await issueStudentIdCard(context, { studentId: randomUUID() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a malformed student id with 'validation'", async () => {
    const { context } = await setupWithStudent("academy_owner");
    const result = await issueStudentIdCard(context, { studentId: "not-a-uuid" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("reprintStudentIdCard", () => {
  it("increments reprint_count without changing card_number, issued_at, or issued_by", async () => {
    const { context, userId, studentId } = await setupWithStudent("academy_owner");
    const issued = await issueStudentIdCard(context, { studentId });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const reprinted = await reprintStudentIdCard(context, issued.card.id);
    expect(reprinted.ok).toBe(true);
    if (!reprinted.ok) return;

    expect(reprinted.card.reprintCount).toBe(1);
    expect(reprinted.card.cardNumber).toBe(issued.card.cardNumber);
    expect(reprinted.card.issuedAt.getTime()).toBe(issued.card.issuedAt.getTime());
    expect(reprinted.card.issuedBy).toBe(userId);

    const secondReprint = await reprintStudentIdCard(context, issued.card.id);
    expect(secondReprint.ok).toBe(true);
    if (secondReprint.ok) expect(secondReprint.card.reprintCount).toBe(2);
  });

  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", true],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: reprint allowed = %s", async (role, allowed) => {
    const owner = await setupWithStudent("academy_owner");
    const issued = await issueStudentIdCard(owner.context, { studentId: owner.studentId });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    if (role === "admissions_officer" || role === "trainer") {
      await assignUserToBranches(owner.academyId, actingUserId, [owner.branchId]);
    }
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const result = await reprintStudentIdCard(actingContext, issued.card.id);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("rejects a nonexistent card id with 'not_found'", async () => {
    const { context } = await setupWithStudent("academy_owner");
    const result = await reprintStudentIdCard(context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("branch-scoped IDOR — Admissions Officer / Trainer", () => {
  it("admissions_officer cannot issue a card for a student outside their assigned branch", async () => {
    const { context, academyId, userId, otherBranchId } = await setupWithStudent(
      "admissions_officer",
      { assignToBranch: true },
    );
    const outsideStudentId = await insertStudentDirect(academyId, otherBranchId, userId);

    const result = await issueStudentIdCard(context, { studentId: outsideStudentId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("admissions_officer cannot reprint a card for a student outside their assigned branch", async () => {
    const owner = await setupWithStudent("academy_owner");
    const outsideStudentId = await insertStudentDirect(
      owner.academyId,
      owner.otherBranchId,
      owner.userId,
    );
    const issued = await issueStudentIdCard(owner.context, { studentId: outsideStudentId });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const officerUserId = await createUser();
    await addMembership(officerUserId, owner.academyId, "admissions_officer");
    await assignUserToBranches(owner.academyId, officerUserId, [owner.branchId]);
    const officerContext: AuthContext = {
      userId: officerUserId,
      branchIds: [],
      academyWide: false,
    };

    const result = await reprintStudentIdCard(officerContext, issued.card.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("trainer cannot issue/reprint at all, regardless of branch assignment (permission level 'none')", async () => {
    const { context, academyId, studentId } = await setupWithStudent("trainer", {
      assignToBranch: true,
    });

    const issueResult = await issueStudentIdCard(context, { studentId });
    expect(issueResult.ok).toBe(false);
    if (!issueResult.ok) expect(issueResult.error.code).toBe("forbidden");

    // Build a card via an owner so there's something to attempt reprinting.
    const ownerUserId = await createUser();
    await addMembership(ownerUserId, academyId, "academy_owner");
    const ownerContext: AuthContext = { userId: ownerUserId, branchIds: [], academyWide: false };
    const issued = await issueStudentIdCard(ownerContext, { studentId });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const reprintResult = await reprintStudentIdCard(context, issued.card.id);
    expect(reprintResult.ok).toBe(false);
    if (!reprintResult.ok) expect(reprintResult.error.code).toBe("forbidden");
  });
});

describe("tenant isolation — cross-academy access", () => {
  it("issueStudentIdCard returns 'not_found' (never 'forbidden') for a student belonging to another academy", async () => {
    const other = await setupWithStudent("academy_owner");
    const { context } = await setupWithStudent("academy_owner");

    const result = await issueStudentIdCard(context, { studentId: other.studentId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("reprintStudentIdCard returns 'not_found' for a card belonging to another academy", async () => {
    const other = await setupWithStudent("academy_owner");
    const issued = await issueStudentIdCard(other.context, { studentId: other.studentId });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const { context } = await setupWithStudent("academy_owner");
    const result = await reprintStudentIdCard(context, issued.card.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("getIdCard", () => {
  it("returns null when no card has been issued yet", async () => {
    const { context, studentId } = await setupWithStudent("academy_owner");
    const result = await getIdCard(context, studentId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card).toBeNull();
  });

  it("returns the most recently issued card", async () => {
    const { context, studentId } = await setupWithStudent("academy_owner");
    await issueStudentIdCard(context, { studentId });
    const second = await issueStudentIdCard(context, { studentId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const result = await getIdCard(context, studentId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card?.id).toBe(second.card.id);
  });

  it("finance_officer is refused entirely with code 'forbidden'", async () => {
    const { context, studentId } = await setupWithStudent("finance_officer");
    const result = await getIdCard(context, studentId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("student_id_cards.card_number — global uniqueness (DB level)", () => {
  it("rejects a duplicate card_number even across two different academies", async () => {
    const first = await setupWithStudent("academy_owner");
    const second = await setupWithStudent("academy_owner");

    const cardNumber = `IDC-${randomUUID().slice(0, 10).toUpperCase()}`;
    await db.insert(studentIdCards).values({
      academyId: first.academyId,
      studentId: first.studentId,
      cardNumber,
      issuedAt: new Date(),
      issuedBy: first.userId,
    });

    await expect(
      db.insert(studentIdCards).values({
        academyId: second.academyId,
        studentId: second.studentId,
        cardNumber,
        issuedAt: new Date(),
        issuedBy: second.userId,
      }),
    ).rejects.toThrow();
  });
});

describe("student_id_cards — FK violations", () => {
  it("rejects an academy_id that doesn't exist", async () => {
    const { studentId, userId } = await setupWithStudent("academy_owner");
    await expect(
      db.insert(studentIdCards).values({
        academyId: randomUUID(),
        studentId,
        cardNumber: `IDC-${randomUUID().slice(0, 10).toUpperCase()}`,
        issuedAt: new Date(),
        issuedBy: userId,
      }),
    ).rejects.toThrow();
  });

  it("rejects a student_id that doesn't exist", async () => {
    const { academyId, userId } = await setupWithStudent("academy_owner");
    await expect(
      db.insert(studentIdCards).values({
        academyId,
        studentId: randomUUID(),
        cardNumber: `IDC-${randomUUID().slice(0, 10).toUpperCase()}`,
        issuedAt: new Date(),
        issuedBy: userId,
      }),
    ).rejects.toThrow();
  });

  it("rejects an issued_by that doesn't exist", async () => {
    const { academyId, studentId } = await setupWithStudent("academy_owner");
    await expect(
      db.insert(studentIdCards).values({
        academyId,
        studentId,
        cardNumber: `IDC-${randomUUID().slice(0, 10).toUpperCase()}`,
        issuedAt: new Date(),
        issuedBy: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});

describe("subscription-state gating", () => {
  it("blocks with code 'blocked' when the academy's subscription is suspended", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const planId = await createPlan();
    await db.insert(academySubscriptions).values({
      academyId,
      planId,
      status: "suspended",
      createdBy: creatorUserId,
    });
    const branchId = await insertBranchDirect(academyId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const userId = await createUser();
    await addMembership(userId, academyId, "academy_owner");

    const result = await issueStudentIdCard(
      { userId, branchIds: [], academyWide: false },
      { studentId },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });
});
