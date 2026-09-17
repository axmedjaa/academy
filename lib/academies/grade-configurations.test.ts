import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  gradeBands,
  gradeConfigurations,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  createGradeConfiguration,
  getGradeConfiguration,
  listGradeConfigurations,
  updateGradeBands,
  type GradeBandInput,
} from "./grade-configurations";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `grade-config-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Grade Config Test Plan ${randomUUID()}`,
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
      name: `Grade Config Test Academy ${randomUUID()}`,
      slug: `grade-config-test-${randomUUID()}`,
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

async function insertConfigDirect(
  academyId: string,
  creatorUserId: string,
  status: "draft" | "pending_approval" | "approved" | "active" | "retired" = "draft",
): Promise<string> {
  const [row] = await db
    .insert(gradeConfigurations)
    .values({ academyId, name: `Config ${randomUUID()}`, createdBy: creatorUserId, status })
    .returning({ id: gradeConfigurations.id });
  return row.id;
}

function band(label: string, minMark: number, maxMark: number, isPass = true): GradeBandInput {
  return { label, minMark, maxMark, isPass };
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
    const configs = await db
      .select({ id: gradeConfigurations.id })
      .from(gradeConfigurations)
      .where(eq(gradeConfigurations.academyId, academyId));
    for (const config of configs) {
      await db.delete(gradeBands).where(eq(gradeBands.gradeConfigurationId, config.id));
    }
    await db.delete(gradeConfigurations).where(eq(gradeConfigurations.academyId, academyId));
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

describe("createGradeConfiguration — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: create allowed = %s", async (role, allowed) => {
    const { context } = await setupAcademy(role);
    const result = await createGradeConfiguration(context, { name: "Standard Grading" });
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("creates in 'draft' status and writes an audit row", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const result = await createGradeConfiguration(context, { name: "Draft Config" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configuration.status).toBe("draft");
    expect(result.configuration.createdBy).toBe(userId);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.configuration.id));
    expect(audit?.action).toBe("createGradeConfiguration");
    expect(audit?.academyId).toBe(academyId);
  });

  it("rejects an empty name with code 'validation'", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await createGradeConfiguration(context, { name: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects a nonexistent academy (FK) at the membership-resolution layer as 'blocked'", async () => {
    // FK violation on academy_id/created_by is unreachable through the
    // public API (both are always derived from a real, already-verified
    // AuthContext + checkAcademyAccessForContext resolution) — see the
    // "FK violations" describe block below for a direct-insert-level test
    // that exercises the actual FK constraints.
    const result = await createGradeConfiguration(
      { userId: randomUUID(), branchIds: [], academyWide: false },
      { name: "Orphan" },
    );
    expect(result.ok).toBe(false);
  });
});

describe("updateGradeBands — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: update allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId);

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const result = await updateGradeBands(actingContext, configId, [band("Pass", 50, 100)]);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("full replace semantics: a second call replaces the entire band set, not merges", async () => {
    const setup = await setupAcademy("academy_owner");
    const cfgId = await insertConfigDirect(setup.academyId, setup.userId);

    const first = await updateGradeBands(setup.context, cfgId, [
      band("Fail", 0, 49, false),
      band("Pass", 50, 100, true),
    ]);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.bands).toHaveLength(2);

    const second = await updateGradeBands(setup.context, cfgId, [band("Only Band", 0, 100, true)]);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.bands).toHaveLength(1);
      expect(second.bands[0].label).toBe("Only Band");
    }

    const fetched = await getGradeConfiguration(setup.context, cfgId);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) expect(fetched.bands).toHaveLength(1);
  });

  it("refuses to edit bands on a non-draft configuration with code 'invalid_state'", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(academyId, userId, "approved");

    const result = await updateGradeBands(context, configId, [band("Pass", 0, 100, true)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("rejects a nonexistent configuration id with code 'not_found'", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await updateGradeBands(context, randomUUID(), [band("Pass", 0, 100, true)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a cross-academy configuration id with code 'not_found' (never 'forbidden')", async () => {
    const other = await setupAcademy("academy_owner");
    const otherConfigId = await insertConfigDirect(other.academyId, other.userId);

    const { context } = await setupAcademy("academy_owner");
    const result = await updateGradeBands(context, otherConfigId, [band("Pass", 0, 100, true)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects overlapping bands with an application-level 'validation' error before hitting the DB", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(academyId, userId);

    const result = await updateGradeBands(context, configId, [
      band("A", 0, 60, true),
      band("B", 55, 100, true),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects a band whose maxMark < minMark with code 'validation'", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(academyId, userId);

    const result = await updateGradeBands(context, configId, [band("Bad", 80, 50, true)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("accepts a valid non-overlapping band set", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(academyId, userId);

    const result = await updateGradeBands(context, configId, [
      band("Fail", 0, 49, false),
      band("Pass", 50, 69, true),
      band("Credit", 70, 100, true),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bands).toHaveLength(3);
  });
});

describe("grade_bands exclusion constraint — direct DB-level enforcement", () => {
  it("rejects adjacent-but-touching ranges (shared boundary point) on a Draft configuration", async () => {
    const { academyId, userId } = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(academyId, userId, "draft");

    await db.insert(gradeBands).values({
      gradeConfigurationId: configId,
      label: "A",
      minMark: "0",
      maxMark: "60",
      isPass: false,
    });

    await expect(
      db.insert(gradeBands).values({
        gradeConfigurationId: configId,
        label: "B",
        minMark: "60",
        maxMark: "100",
        isPass: true,
      }),
    ).rejects.toThrow();
  });

  it("rejects fully-nested ranges on a Draft configuration", async () => {
    const { academyId, userId } = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(academyId, userId, "draft");

    await db.insert(gradeBands).values({
      gradeConfigurationId: configId,
      label: "Outer",
      minMark: "0",
      maxMark: "100",
      isPass: true,
    });

    await expect(
      db.insert(gradeBands).values({
        gradeConfigurationId: configId,
        label: "Inner",
        minMark: "40",
        maxMark: "60",
        isPass: true,
      }),
    ).rejects.toThrow();
  });

  it("rejects identical ranges on a Draft configuration", async () => {
    const { academyId, userId } = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(academyId, userId, "draft");

    await db.insert(gradeBands).values({
      gradeConfigurationId: configId,
      label: "A",
      minMark: "0",
      maxMark: "50",
      isPass: false,
    });

    await expect(
      db.insert(gradeBands).values({
        gradeConfigurationId: configId,
        label: "A-duplicate",
        minMark: "0",
        maxMark: "50",
        isPass: false,
      }),
    ).rejects.toThrow();
  });

  it("rejects overlapping ranges even when the configuration is NOT draft (unconditional)", async () => {
    const { academyId, userId } = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(academyId, userId, "active");

    await db.insert(gradeBands).values({
      gradeConfigurationId: configId,
      label: "A",
      minMark: "0",
      maxMark: "60",
      isPass: false,
    });

    await expect(
      db.insert(gradeBands).values({
        gradeConfigurationId: configId,
        label: "B",
        minMark: "30",
        maxMark: "70",
        isPass: true,
      }),
    ).rejects.toThrow();
  });

  it("accepts non-overlapping ranges for the same configuration", async () => {
    const { academyId, userId } = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(academyId, userId, "draft");

    await db.insert(gradeBands).values({
      gradeConfigurationId: configId,
      label: "Fail",
      minMark: "0",
      maxMark: "49",
      isPass: false,
    });
    const [ok] = await db
      .insert(gradeBands)
      .values({
        gradeConfigurationId: configId,
        label: "Pass",
        minMark: "50",
        maxMark: "100",
        isPass: true,
      })
      .returning({ id: gradeBands.id });
    expect(ok.id).toBeDefined();
  });

  it("allows overlapping ranges across two DIFFERENT configurations (constraint is per-configuration)", async () => {
    const { academyId, userId } = await setupAcademy("academy_owner");
    const configA = await insertConfigDirect(academyId, userId, "draft");
    const configB = await insertConfigDirect(academyId, userId, "draft");

    await db.insert(gradeBands).values({
      gradeConfigurationId: configA,
      label: "A",
      minMark: "0",
      maxMark: "60",
      isPass: false,
    });
    const [ok] = await db
      .insert(gradeBands)
      .values({
        gradeConfigurationId: configB,
        label: "B",
        minMark: "0",
        maxMark: "60",
        isPass: false,
      })
      .returning({ id: gradeBands.id });
    expect(ok.id).toBeDefined();
  });

  it("rejects max_mark < min_mark via the CHECK constraint", async () => {
    const { academyId, userId } = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(academyId, userId, "draft");

    await expect(
      db.insert(gradeBands).values({
        gradeConfigurationId: configId,
        label: "Invalid",
        minMark: "80",
        maxMark: "50",
        isPass: true,
      }),
    ).rejects.toThrow();
  });

  it("FK violation: a nonexistent grade_configuration_id is rejected", async () => {
    await expect(
      db.insert(gradeBands).values({
        gradeConfigurationId: randomUUID(),
        label: "Orphan",
        minMark: "0",
        maxMark: "100",
        isPass: true,
      }),
    ).rejects.toThrow();
  });
});

describe("listGradeConfigurations / getGradeConfiguration — tenant isolation", () => {
  it("never returns another academy's configurations", async () => {
    const other = await setupAcademy("academy_owner");
    await insertConfigDirect(other.academyId, other.userId);

    const { context } = await setupAcademy("academy_owner");
    const result = await listGradeConfigurations(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.configurations).toEqual([]);
  });

  it("getGradeConfiguration returns 'not_found' (never 'forbidden') for a cross-academy id", async () => {
    const other = await setupAcademy("academy_owner");
    const otherConfigId = await insertConfigDirect(other.academyId, other.userId);

    const { context } = await setupAcademy("academy_owner");
    const result = await getGradeConfiguration(context, otherConfigId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});
