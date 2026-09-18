import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  approvalRequests,
  auditLogs,
  gradeBands,
  gradeConfigurations,
  notifications,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  activateGradeConfiguration,
  approveGradeConfig,
  createGradeConfiguration,
  getGradeConfiguration,
  listGradeConfigurations,
  rejectGradeConfig,
  submitGradeConfigForApproval,
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
  // Item 47: approval_requests rows created by submitGradeConfigForApproval
  // FK-reference both academies.id and users.id (requested_by/decided_by) —
  // must be cleared before those tables' own rows below, same ordering
  // concern as auditLogs above.
  if (createdAcademyIds.length > 0) {
    await db
      .delete(approvalRequests)
      .where(or(...createdAcademyIds.map((id) => eq(approvalRequests.academyId, id))));
    // Item 58b: createApprovalRequest/decideApprovalRequest now enqueue a
    // notification row FK-referencing academies.id (and, for the decision,
    // users.id) — must be cleared before those tables' own delete below.
    await db
      .delete(notifications)
      .where(or(...createdAcademyIds.map((id) => eq(notifications.academyId, id))));
  }
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

// ---------------------------------------------------------------------------
// PLAN.md Item 47 — the Grade-Configuration Lifecycle table's remaining four
// transitions: submitGradeConfigForApproval, approveGradeConfig,
// rejectGradeConfig, activateGradeConfiguration.
// ---------------------------------------------------------------------------

/** Adds a second membership of the given role to an already-set-up academy,
 * returning a fresh AuthContext for that new user — the standard way this
 * suite gets two *distinct* actors (e.g. a submitter and a separate
 * approver) within the same academy, since self-approval must be tested
 * against a genuinely different user, not just a different role. */
async function addActingUser(
  academyId: string,
  role: AcademyRole,
): Promise<{ userId: string; context: AuthContext }> {
  const userId = await createUser();
  await addMembership(userId, academyId, role);
  return { userId, context: { userId, branchIds: [], academyWide: false } };
}

async function fetchApprovalRequestForConfig(gradeConfigurationId: string) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.entityType, "grade_configuration"),
        eq(approvalRequests.entityId, gradeConfigurationId),
      ),
    );
  return row;
}

describe("submitGradeConfigForApproval — Draft -> Pending Approval", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: submit allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId);
    const actor = await addActingUser(owner.academyId, role);

    const result = await submitGradeConfigForApproval(actor.context, configId);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("flips status to pending_approval and creates a matching pending approval_requests row", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId);

    const result = await submitGradeConfigForApproval(owner.context, configId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configuration.status).toBe("pending_approval");

    const request = await fetchApprovalRequestForConfig(configId);
    expect(request?.status).toBe("pending");
    expect(request?.requestedBy).toBe(owner.userId);
    expect(request?.academyId).toBe(owner.academyId);
  });

  it("refuses to submit a non-draft configuration with code 'invalid_state'", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId, "pending_approval");

    const result = await submitGradeConfigForApproval(owner.context, configId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("rejects a nonexistent configuration id with code 'not_found'", async () => {
    const owner = await setupAcademy("academy_owner");
    const result = await submitGradeConfigForApproval(owner.context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a cross-academy configuration id with code 'not_found' (never 'forbidden')", async () => {
    const other = await setupAcademy("academy_owner");
    const otherConfigId = await insertConfigDirect(other.academyId, other.userId);

    const owner = await setupAcademy("academy_owner");
    const result = await submitGradeConfigForApproval(owner.context, otherConfigId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("approveGradeConfig — Pending Approval -> Approved (authority: Manager/Owner via Full only)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", false],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])(
    "role %s: approve allowed = %s (Admin's 'manage' level must be refused even though it can submit)",
    async (role, allowed) => {
      const owner = await setupAcademy("academy_owner");
      const configId = await insertConfigDirect(owner.academyId, owner.userId);
      const submitResult = await submitGradeConfigForApproval(owner.context, configId);
      expect(submitResult.ok).toBe(true);

      // A different user than the submitter (owner.userId), so a "forbidden"
      // result here is unambiguously about permission level, never
      // self-approval.
      const approver = await addActingUser(owner.academyId, role);
      const result = await approveGradeConfig(approver.context, configId);
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("approves: status -> approved, approved_by/approved_at set, approval_requests row decided", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId);
    await submitGradeConfigForApproval(owner.context, configId);

    const manager = await addActingUser(owner.academyId, "manager");
    const result = await approveGradeConfig(manager.context, configId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configuration.status).toBe("approved");
    expect(result.configuration.approvedBy).toBe(manager.userId);
    expect(result.configuration.approvedAt).not.toBeNull();

    const request = await fetchApprovalRequestForConfig(configId);
    expect(request?.status).toBe("approved");
    expect(request?.decidedBy).toBe(manager.userId);
    expect(request?.decidedAt).not.toBeNull();
  });

  it("refuses self-approval with code 'self_approval', even for a submitter who holds Full authority", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId);
    // The submitter here is a Manager (holds "full" on academy.grade_bands,
    // i.e. approval-capable in general) — proving the refusal is specifically
    // about self-approval, not merely an insufficient permission level.
    const submitter = await addActingUser(owner.academyId, "manager");
    await submitGradeConfigForApproval(submitter.context, configId);

    const result = await approveGradeConfig(submitter.context, configId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");

    // Never the submitter, but the config is untouched by the refused call.
    const stillPending = await getGradeConfiguration(owner.context, configId);
    expect(stillPending.ok).toBe(true);
    if (stillPending.ok) expect(stillPending.configuration.status).toBe("pending_approval");

    // A different Manager can still approve it.
    const otherManager = await addActingUser(owner.academyId, "manager");
    const approved = await approveGradeConfig(otherManager.context, configId);
    expect(approved.ok).toBe(true);
  });

  it("refuses to approve a configuration that was never submitted (still 'draft') with code 'invalid_state'", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId, "draft");

    const result = await approveGradeConfig(owner.context, configId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("refuses to approve an already-approved configuration with code 'invalid_state'", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId);
    await submitGradeConfigForApproval(owner.context, configId);
    const manager = await addActingUser(owner.academyId, "manager");
    await approveGradeConfig(manager.context, configId);

    const result = await approveGradeConfig(manager.context, configId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("rejects a nonexistent configuration id with code 'not_found'", async () => {
    const owner = await setupAcademy("academy_owner");
    const result = await approveGradeConfig(owner.context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("rejectGradeConfig — Pending Approval back to Draft (same authority as approve)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", false],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: reject allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId);
    await submitGradeConfigForApproval(owner.context, configId);

    const decider = await addActingUser(owner.academyId, role);
    const result = await rejectGradeConfig(decider.context, configId, "Bands need revision.");
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("requires a non-empty reason with code 'validation'", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId);
    await submitGradeConfigForApproval(owner.context, configId);
    const manager = await addActingUser(owner.academyId, "manager");

    const result = await rejectGradeConfig(manager.context, configId, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("refuses self-rejection with code 'self_approval'", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId);
    const submitter = await addActingUser(owner.academyId, "manager");
    await submitGradeConfigForApproval(submitter.context, configId);

    const result = await rejectGradeConfig(submitter.context, configId, "Changed my mind.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");
  });

  it("rejects: status returns to 'draft' on the SAME row, reason persisted, and it becomes editable again", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId);
    await submitGradeConfigForApproval(owner.context, configId);

    const manager = await addActingUser(owner.academyId, "manager");
    const result = await rejectGradeConfig(manager.context, configId, "Fail band overlaps pass band.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configuration.id).toBe(configId); // same row, not a new one
    expect(result.configuration.status).toBe("draft");

    const request = await fetchApprovalRequestForConfig(configId);
    expect(request?.status).toBe("rejected");
    expect(request?.decidedBy).toBe(manager.userId);
    expect(request?.reason).toBe("Fail band overlaps pass band.");

    // Item 46's updateGradeBands refuses non-draft configs — now that this
    // row is back in 'draft', it must accept edits again (PLAN.md: "the
    // same row, not a new one — re-editable via updateGradeBands").
    const editResult = await updateGradeBands(owner.context, configId, [
      band("Pass", 40, 100, true),
    ]);
    expect(editResult.ok).toBe(true);
  });

  it("refuses to reject a configuration that isn't pending approval with code 'invalid_state'", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId, "draft");

    const result = await rejectGradeConfig(owner.context, configId, "Not applicable.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });
});

describe("activateGradeConfiguration — Approved -> Active (two-row atomic transaction)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: activate allowed = %s (Admin IS allowed here, unlike approve/reject)", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId, "approved");
    const actor = await addActingUser(owner.academyId, role);

    const result = await activateGradeConfiguration(actor.context, configId);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("activates a configuration when the academy has no prior Active configuration", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId, "approved");

    const result = await activateGradeConfiguration(owner.context, configId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configuration.status).toBe("active");
    expect(result.configuration.activatedAt).not.toBeNull();
    expect(result.retiredConfiguration).toBeNull();
  });

  it("two-row atomic transaction: the previously Active configuration flips to Retired in the same call", async () => {
    const owner = await setupAcademy("academy_owner");
    const oldActiveId = await insertConfigDirect(owner.academyId, owner.userId, "active");
    const newApprovedId = await insertConfigDirect(owner.academyId, owner.userId, "approved");

    const result = await activateGradeConfiguration(owner.context, newApprovedId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.configuration.id).toBe(newApprovedId);
    expect(result.configuration.status).toBe("active");
    expect(result.retiredConfiguration?.id).toBe(oldActiveId);
    expect(result.retiredConfiguration?.status).toBe("retired");
    expect(result.retiredConfiguration?.retiredAt).not.toBeNull();

    // Only one Active configuration per academy at a time — confirmed
    // directly against the DB, not just the function's return value.
    const rows = await db
      .select({ id: gradeConfigurations.id, status: gradeConfigurations.status })
      .from(gradeConfigurations)
      .where(eq(gradeConfigurations.academyId, owner.academyId));
    const activeRows = rows.filter((row) => row.status === "active");
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].id).toBe(newApprovedId);
  });

  it("rollback-safety: if the transaction fails partway through, the previously Active row is NOT left Retired without a new Active row", async () => {
    // activateGradeConfiguration's own public API gives no injectable
    // failure point between its two `tx.update()` calls (no unique/DB-level
    // constraint exists to violate on the second write — "only one Active
    // configuration at a time" is enforced by this function's own logic,
    // not a DB constraint, per PLAN.md's schema for grade_configurations).
    // This test instead proves the underlying guarantee the function
    // depends on: the exact same "retire the old Active row, then write the
    // new Active row" sequence, run inside one db.transaction, rolls both
    // writes back together if anything after the first write throws — the
    // identical technique lib/audit.test.ts uses to prove recordAudit's own
    // transaction participation ("rolled back mutation leaves no audit
    // row"). If Postgres transactions did not roll back this way,
    // activateGradeConfiguration's own atomicity claim would be false.
    const owner = await setupAcademy("academy_owner");
    const oldActiveId = await insertConfigDirect(owner.academyId, owner.userId, "active");
    const newApprovedId = await insertConfigDirect(owner.academyId, owner.userId, "approved");

    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(gradeConfigurations)
          .set({ status: "retired", retiredAt: new Date() })
          .where(eq(gradeConfigurations.id, oldActiveId));
        throw new Error("simulated failure before the second (activate) write");
      }),
    ).rejects.toThrow("simulated failure before the second (activate) write");

    const [oldRow] = await db
      .select({ status: gradeConfigurations.status })
      .from(gradeConfigurations)
      .where(eq(gradeConfigurations.id, oldActiveId));
    const [newRow] = await db
      .select({ status: gradeConfigurations.status })
      .from(gradeConfigurations)
      .where(eq(gradeConfigurations.id, newApprovedId));

    // The retire write did NOT stick — rolled back with the rest of the
    // transaction, exactly as activateGradeConfiguration's own two writes
    // would if its second write ever threw.
    expect(oldRow.status).toBe("active");
    expect(newRow.status).toBe("approved");
  });

  it("refuses to activate a configuration that isn't 'approved' (e.g. still 'draft') with code 'invalid_state'", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId, "draft");

    const result = await activateGradeConfiguration(owner.context, configId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("refuses to activate an already-active configuration with code 'invalid_state'", async () => {
    const owner = await setupAcademy("academy_owner");
    const configId = await insertConfigDirect(owner.academyId, owner.userId, "active");

    const result = await activateGradeConfiguration(owner.context, configId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("rejects a nonexistent configuration id with code 'not_found'", async () => {
    const owner = await setupAcademy("academy_owner");
    const result = await activateGradeConfiguration(owner.context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("Active configuration has no in-place edit (judgment call: 'new Draft revision' = create a fresh Draft, no dedicated revision function)", () => {
  it("updateGradeBands refuses to edit an Active configuration's bands directly, with code 'invalid_state'", async () => {
    const owner = await setupAcademy("academy_owner");
    const activeId = await insertConfigDirect(owner.academyId, owner.userId, "active");

    const result = await updateGradeBands(owner.context, activeId, [band("New Pass", 0, 100, true)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("createGradeConfiguration is unrestricted by an existing Active configuration — the 'revision' path is simply creating a new Draft", async () => {
    // PLAN.md's lifecycle table row for Active says "any change creates a
    // new Draft revision instead" but names no dedicated
    // "reviseGradeConfiguration" action anywhere in §4's action list — the
    // only Draft-creating action this plan defines is
    // createGradeConfiguration (Item 46), which has no "only one Draft at a
    // time" or "must supersede the Active config" restriction. This test
    // documents that interpretation: an academy may freely createGradeConfiguration
    // again while another configuration is Active, and that new Draft is
    // the "revision" — it goes through the exact same
        // Draft -> Pending Approval -> Approved -> Active lifecycle as any other
    // configuration, and only becomes the academy's live configuration once
    // activateGradeConfiguration explicitly retires the old Active row (see
    // the "two-row atomic transaction" describe block above for that
    // end-to-end path).
    const owner = await setupAcademy("academy_owner");
    await insertConfigDirect(owner.academyId, owner.userId, "active");

    const result = await createGradeConfiguration(owner.context, { name: "Revised Grading Scheme" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configuration.status).toBe("draft");

    const listResult = await listGradeConfigurations(owner.context);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      const statuses = listResult.configurations.map((config) => config.status).sort();
      expect(statuses).toEqual(["active", "draft"]);
    }
  });

  it("end-to-end: a new Draft revision fully replaces the old Active configuration once activated", async () => {
    const owner = await setupAcademy("academy_owner");
    const oldActiveId = await insertConfigDirect(owner.academyId, owner.userId, "active");

    const created = await createGradeConfiguration(owner.context, { name: "Revised Grading Scheme" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const newConfigId = created.configuration.id;

    await updateGradeBands(owner.context, newConfigId, [
      band("Fail", 0, 39, false),
      band("Pass", 40, 100, true),
    ]);
    await submitGradeConfigForApproval(owner.context, newConfigId);
    const manager = await addActingUser(owner.academyId, "manager");
    await approveGradeConfig(manager.context, newConfigId);
    const activation = await activateGradeConfiguration(owner.context, newConfigId);

    expect(activation.ok).toBe(true);
    if (!activation.ok) return;
    expect(activation.configuration.status).toBe("active");
    expect(activation.retiredConfiguration?.id).toBe(oldActiveId);
    expect(activation.retiredConfiguration?.status).toBe("retired");

    // Retiring the old configuration never touches any existing result —
    // out of this item's scope to assert against exam_results directly (no
    // such rows exist in this test), but the config-side half of that
    // guarantee is that the retired row itself is otherwise untouched
    // (same id, same bands ownership) — just a status/retired_at flip.
    const oldConfig = await getGradeConfiguration(owner.context, oldActiveId);
    expect(oldConfig.ok).toBe(true);
    if (oldConfig.ok) expect(oldConfig.configuration.status).toBe("retired");
  });
});
