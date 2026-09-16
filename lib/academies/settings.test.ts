import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  academyUsage,
  auditLogs,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  getAcademySettings,
  getOwnAcademyUsage,
  updateAcademySettings,
  type UpdateAcademySettingsInput,
} from "./settings";

const DAY_MS = 24 * 60 * 60 * 1000;

// Same "one top-level cleanup, every test builds its own fully isolated
// fixture set" convention as lib/academies/access-gate.test.ts, plus the
// FK-ordering rule established there and in register.test.ts: audit_logs
// must be deleted before the academies/users/academy_subscriptions rows it
// references.
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `academy-settings-test-${randomUUID()}@example.com`,
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
      name: `Academy Settings Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 3,
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
      name: `Academy Settings Test Academy ${randomUUID()}`,
      slug: `academy-settings-test-${randomUUID()}`,
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

/** Full fixture: a fresh academy, one active plan/subscription, and one
 * membership of the given role — the shape every test below needs. */
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

  return {
    academyId,
    userId,
    context: { userId, branchIds: [], academyWide: false },
  };
}

function validInput(
  overrides: Partial<UpdateAcademySettingsInput> = {},
): UpdateAcademySettingsInput {
  return {
    name: `Updated Academy Name ${randomUUID()}`,
    type: "language_school",
    address: "123 Main St",
    phone: "+1-555-0100",
    email: "contact@example.com",
    website: "https://example.com",
    logoRef: "logos/example.png",
    registrationNumber: "REG-123",
    primaryContactName: "Jane Doe",
    primaryContactPhone: "+1-555-0101",
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
    await db.delete(academyUsage).where(eq(academyUsage.academyId, academyId));
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

describe("updateAcademySettings — positive access (Full / View-Edit)", () => {
  it("allows academy_owner to update settings (Full) and writes an audit row", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const input = validInput({ name: "Owner Updated Name" });

    const result = await updateAcademySettings(context, input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.academy.name).toBe("Owner Updated Name");
      expect(result.academy.type).toBe("language_school");
    }

    const [row] = await db.select().from(academies).where(eq(academies.id, academyId));
    expect(row?.name).toBe("Owner Updated Name");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, academyId));
    expect(audit?.action).toBe("updateAcademySettings");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.actorRole).toBe("academy_owner");
  });

  it("allows academy_admin to update settings (Full)", async () => {
    const { context } = await setupAcademy("academy_admin");
    const result = await updateAcademySettings(context, validInput({ name: "Admin Updated" }));
    expect(result.ok).toBe(true);
  });

  it("allows manager to update settings (View/Edit) — same edit capability as Full for this row", async () => {
    const { context } = await setupAcademy("manager");
    const result = await updateAcademySettings(context, validInput({ name: "Manager Updated" }));
    expect(result.ok).toBe(true);
  });
});

describe("updateAcademySettings — negative access (—)", () => {
  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden' and makes no change",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const [before] = await db.select().from(academies).where(eq(academies.id, academyId));

      const result = await updateAcademySettings(context, validInput({ name: "Should Not Apply" }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("forbidden");
      }

      const [after] = await db.select().from(academies).where(eq(academies.id, academyId));
      expect(after?.name).toBe(before?.name);
    },
  );
});

describe("updateAcademySettings — validation", () => {
  it("rejects an empty name", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await updateAcademySettings(context, validInput({ name: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects an invalid email", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await updateAcademySettings(context, validInput({ email: "not-an-email" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("normalizes blank optional fields to null rather than empty strings", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await updateAcademySettings(
      context,
      validInput({ website: "", logoRef: "" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.academy.website).toBeNull();
      expect(result.academy.logoRef).toBeNull();
    }
  });
});

describe("updateAcademySettings — immutable fields", () => {
  it("never changes slug or defaultCurrency, even though they're not part of the input shape", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const [before] = await db.select().from(academies).where(eq(academies.id, academyId));

    await updateAcademySettings(context, validInput());

    const [after] = await db.select().from(academies).where(eq(academies.id, academyId));
    expect(after?.slug).toBe(before?.slug);
    expect(after?.defaultCurrency).toBe(before?.defaultCurrency);
  });
});

describe("updateAcademySettings — subscription-state gating", () => {
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
    const userId = await createUser();
    await addMembership(userId, academyId, "academy_owner");

    const result = await updateAcademySettings(
      { userId, branchIds: [], academyWide: false },
      validInput(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });

  it("still allows the update during the grace period (Past Due, within 7 days)", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const planId = await createPlan();
    await db.insert(academySubscriptions).values({
      academyId,
      planId,
      status: "active",
      startsAt: new Date(Date.now() - 30 * DAY_MS),
      endsAt: new Date(Date.now() - 2 * DAY_MS),
      createdBy: creatorUserId,
    });
    const userId = await createUser();
    await addMembership(userId, academyId, "academy_owner");

    const result = await updateAcademySettings(
      { userId, branchIds: [], academyWide: false },
      validInput({ name: "Grace Period Update" }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("getAcademySettings", () => {
  it("returns the current record and permission level for academy_owner ('full')", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const result = await getAcademySettings(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.academy.id).toBe(academyId);
      expect(result.permissionLevel).toBe("full");
    }
  });

  it("returns 'view_edit' for manager", async () => {
    const { context } = await setupAcademy("manager");
    const result = await getAcademySettings(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.permissionLevel).toBe("view_edit");
  });

  it("refuses trainer with code 'forbidden'", async () => {
    const { context } = await setupAcademy("trainer");
    const result = await getAcademySettings(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("getOwnAcademyUsage", () => {
  it("returns null usage when recalculateUsage has never run, but real plan limits", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await getOwnAcademyUsage(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toBeNull();
      expect(result.limits).toEqual({
        maxBranches: 3,
        maxStudents: 100,
        maxStaff: 10,
        maxCourses: 10,
        maxStorageBytes: 1_073_741_824,
      });
    }
  });

  it("returns the latest academy_usage snapshot when one exists", async () => {
    const { academyId, context } = await setupAcademy("academy_admin");
    await db.insert(academyUsage).values({
      academyId,
      activeStudentsCount: 5,
      activeStaffCount: 2,
      branchCount: 1,
      courseCount: 0,
      storageUsedBytes: 1024,
    });

    const result = await getOwnAcademyUsage(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage?.activeStudentsCount).toBe(5);
      expect(result.usage?.branchCount).toBe(1);
    }
  });

  it("never returns another academy's usage snapshot (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner");
    await db.insert(academyUsage).values({
      academyId: other.academyId,
      activeStudentsCount: 999,
      activeStaffCount: 999,
      branchCount: 999,
      courseCount: 999,
      storageUsedBytes: 999,
    });

    const { context } = await setupAcademy("academy_owner");
    const result = await getOwnAcademyUsage(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toBeNull();
    }
  });

  it("refuses finance_officer with code 'forbidden'", async () => {
    const { context } = await setupAcademy("finance_officer");
    const result = await getOwnAcademyUsage(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});
