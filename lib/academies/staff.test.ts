import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  staffProfiles,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { ACADEMY_ROLES, type AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { ACADEMY_STAFF_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { checkAllowance } from "@/lib/subscriptions/usage";
import {
  assignStaffRole,
  createStaff,
  listStaff,
  updateStaff,
  type CreateStaffInput,
} from "./staff";

// Same "one top-level cleanup, every test builds its own fully isolated
// fixture set" convention as lib/academies/settings.test.ts, plus the same
// FK-ordering rule (audit_logs before academies/users/subscriptions).
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `staff-action-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(maxStaff = 10): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Staff Action Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 3,
      maxStudents: 100,
      maxStaff,
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
      name: `Staff Action Test Academy ${randomUUID()}`,
      slug: `staff-action-test-${randomUUID()}`,
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

/** Full fixture: a fresh academy, one active plan/subscription (maxStaff
 * configurable for allowance tests), and one membership of the given role. */
async function setupAcademy(
  role: AcademyRole,
  maxStaff = 10,
): Promise<{ academyId: string; userId: string; context: AuthContext }> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan(maxStaff);
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
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

/** Inserts a staff_profiles row + academy_memberships row directly
 * (bypassing createStaff's own permission gate), for tests that need an
 * existing staff member as the *target* of updateStaff/assignStaffRole. */
async function createTargetStaff(
  academyId: string,
  role: AcademyRole = "trainer",
): Promise<{ staffProfileId: string; userId: string }> {
  const userId = await createUser();
  await addMembership(userId, academyId, role);
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Target Staff", phone: "+1-555-0000" })
    .returning({ id: staffProfiles.id });
  return { staffProfileId: profile.id, userId };
}

async function seedActiveStaff(academyId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const staffUserId = await createUser();
    await db.insert(staffProfiles).values({
      academyId,
      userId: staffUserId,
      fullName: `Seed Staff ${i}`,
      phone: "+1-555-0000",
      status: "active",
    });
  }
}

function validCreateInput(overrides: Partial<CreateStaffInput> = {}): CreateStaffInput {
  return {
    email: `new-staff-${randomUUID()}@example.com`,
    password: "supersecurepassword123",
    fullName: "New Staff Member",
    phone: "+1-555-0123",
    employeeNumber: "EMP-100",
    hireDate: "2024-01-01",
    role: "trainer",
    ...overrides,
  };
}

/** createStaff wrapper that also tracks the new user it creates for cleanup. */
async function createStaffTracked(context: AuthContext, input: CreateStaffInput) {
  const result = await createStaff(context, input);
  if (result.ok) createdUserIds.push(result.userId);
  return result;
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
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
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

describe("academy.staff permission levels (Master Permission Matrix 'Staff' row)", () => {
  it("matches Full/Full/Manage/none/none/View exactly", () => {
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_STAFF_ACTION)).toBe("full");
    expect(getAcademyPermissionLevel("academy_admin", ACADEMY_STAFF_ACTION)).toBe("full");
    expect(getAcademyPermissionLevel("manager", ACADEMY_STAFF_ACTION)).toBe("manage");
    expect(getAcademyPermissionLevel("admissions_officer", ACADEMY_STAFF_ACTION)).toBe("none");
    expect(getAcademyPermissionLevel("finance_officer", ACADEMY_STAFF_ACTION)).toBe("none");
    expect(getAcademyPermissionLevel("trainer", ACADEMY_STAFF_ACTION)).toBe("view");
  });

  it("covers every ACADEMY_ROLES member (no role silently unhandled)", () => {
    const expected: Record<AcademyRole, string> = {
      academy_owner: "full",
      academy_admin: "full",
      manager: "manage",
      admissions_officer: "none",
      finance_officer: "none",
      trainer: "view",
    };
    for (const role of ACADEMY_ROLES) {
      expect(getAcademyPermissionLevel(role, ACADEMY_STAFF_ACTION)).toBe(expected[role]);
    }
  });
});

describe("checkAllowance('staff') reflects real staff_profiles data (countActiveStaff is no longer the 0 stub)", () => {
  it("counts only active staff_profiles rows for the academy, excluding archived", async () => {
    const { academyId } = await setupAcademy("academy_owner", 5);
    await seedActiveStaff(academyId, 3);

    const archivedUserId = await createUser();
    await db.insert(staffProfiles).values({
      academyId,
      userId: archivedUserId,
      fullName: "Archived Staff",
      phone: "+1-555-0000",
      status: "archived",
    });

    const outcome = await checkAllowance(academyId, "staff");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.current).toBe(3);
      expect(outcome.result.limit).toBe(5);
      expect(outcome.result.allowed).toBe(true);
    }
  });

  it("never counts another academy's staff (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner", 5);
    await seedActiveStaff(other.academyId, 4);

    const { academyId } = await setupAcademy("academy_owner", 5);
    const outcome = await checkAllowance(academyId, "staff");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.current).toBe(0);
  });
});

describe("createStaff — hard block at the plan's staff allowance limit", () => {
  it("rejects creation once active staff_profiles reaches the plan limit, with no partial writes", async () => {
    const { academyId, context } = await setupAcademy("academy_owner", 2);
    await seedActiveStaff(academyId, 2);

    const input = validCreateInput();
    const result = await createStaff(context, input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("allowance_exceeded");
    }

    // No user row was created for the rejected attempt (transaction rolled back).
    const [leaked] = await db.select().from(users).where(eq(users.email, input.email));
    expect(leaked).toBeUndefined();

    // Still exactly the 2 seeded rows — no orphaned partial insert.
    const all = await db
      .select({ id: staffProfiles.id })
      .from(staffProfiles)
      .where(eq(staffProfiles.academyId, academyId));
    expect(all.length).toBe(2);
  });

  it("allows creation again once a staff member is archived, freeing the slot", async () => {
    const { context } = await setupAcademy("academy_owner", 1);

    const first = await createStaffTracked(context, validCreateInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const blocked = await createStaff(context, validCreateInput());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("allowance_exceeded");

    const archived = await updateStaff(context, first.staffProfileId, {
      fullName: "New Staff Member",
      phone: "+1-555-0123",
      status: "archived",
    });
    expect(archived.ok).toBe(true);

    const afterArchive = await createStaffTracked(context, validCreateInput());
    expect(afterArchive.ok).toBe(true);
  });
});

describe("createStaff — the create/reuse/audit transaction", () => {
  it("creates a users row, a staff_profiles row, and an academy_memberships row with the assigned role, all audited", async () => {
    const { academyId, userId: actorUserId, context } = await setupAcademy("academy_owner");
    const input = validCreateInput({ role: "manager" });

    const result = await createStaffTracked(context, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user?.email).toBe(input.email);

    const [profile] = await db
      .select()
      .from(staffProfiles)
      .where(eq(staffProfiles.id, result.staffProfileId));
    expect(profile?.fullName).toBe(input.fullName);
    expect(profile?.academyId).toBe(academyId);
    expect(profile?.status).toBe("active");

    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(
        and(eq(academyMemberships.userId, result.userId), eq(academyMemberships.academyId, academyId)),
      );
    expect(membership?.role).toBe("manager");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.staffProfileId));
    expect(audit?.action).toBe("createStaff");
    expect(audit?.actorUserId).toBe(actorUserId);
    expect(audit?.actorRole).toBe("academy_owner");
  });

  it("reuses an existing users row for an email that already has an account, rather than creating a duplicate", async () => {
    const { context } = await setupAcademy("academy_owner");
    const existingUserId = await createUser();
    const [existingUser] = await db.select().from(users).where(eq(users.id, existingUserId));

    const result = await createStaffTracked(
      context,
      validCreateInput({ email: existingUser.email, password: undefined }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe(existingUserId);

    const matchingUsers = await db.select().from(users).where(eq(users.email, existingUser.email));
    expect(matchingUsers.length).toBe(1);
  });

  it("requires a password when creating a brand-new account", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await createStaff(context, validCreateInput({ password: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("refuses when the target is already staff at this academy", async () => {
    const { context } = await setupAcademy("academy_owner");
    const input = validCreateInput();

    const first = await createStaffTracked(context, input);
    expect(first.ok).toBe(true);

    const second = await createStaff(context, { ...input, password: undefined });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("already_staff");
  });

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
    const ownerUserId = await createUser();
    await addMembership(ownerUserId, academyId, "academy_owner");

    const result = await createStaff(
      { userId: ownerUserId, branchIds: [], academyWide: false },
      validCreateInput(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });
});

describe("createStaff — permission matrix (Full/Manage may create, everyone else refused)", () => {
  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "allows %s to create a staff member",
    async (role) => {
      const { context } = await setupAcademy(role);
      const result = await createStaffTracked(context, validCreateInput());
      expect(result.ok).toBe(true);
    },
  );

  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const { context } = await setupAcademy(role);
      const result = await createStaff(context, validCreateInput());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );
});

describe("updateStaff", () => {
  it("updates the employment record fields and audits before/after", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId);

    const result = await updateStaff(context, target.staffProfileId, {
      fullName: "Updated Name",
      phone: "+1-555-9999",
      employeeNumber: "EMP-999",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.staff.fullName).toBe("Updated Name");
      expect(result.staff.employeeNumber).toBe("EMP-999");
    }

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, target.staffProfileId));
    expect(audit?.action).toBe("updateStaff");
  });

  it("returns not_found for a staffProfileId belonging to another academy (tenant isolation / IDOR guard)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherTarget = await createTargetStaff(other.academyId);

    const { context } = await setupAcademy("academy_owner");
    const result = await updateStaff(context, otherTarget.staffProfileId, {
      fullName: "Hijacked",
      phone: "+1-555-0000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "allows %s to update staff",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId);
      const result = await updateStaff(context, target.staffProfileId, {
        fullName: "Manager Updated",
        phone: "+1-555-0001",
      });
      expect(result.ok).toBe(true);
    },
  );

  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId);
      const result = await updateStaff(context, target.staffProfileId, {
        fullName: "Should Not Apply",
        phone: "+1-555-0002",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );
});

describe("assignStaffRole", () => {
  it("updates the target's academy_memberships.role and audits before/after", async () => {
    const { academyId, userId: actorUserId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId, "trainer");

    const result = await assignStaffRole(context, target.userId, "manager");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role).toBe("manager");

    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(
        and(
          eq(academyMemberships.userId, target.userId),
          eq(academyMemberships.academyId, academyId),
        ),
      );
    expect(membership.role).toBe("manager");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, membership.id));
    expect(audit?.action).toBe("assignStaffRole");
    expect(audit?.actorUserId).toBe(actorUserId);
  });

  it("returns not_found when the target has no membership in this academy", async () => {
    const { context } = await setupAcademy("academy_owner");
    const strangerUserId = await createUser();

    const result = await assignStaffRole(context, strangerUserId, "manager");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "allows %s to assign a role",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId, "trainer");
      const result = await assignStaffRole(context, target.userId, "finance_officer");
      expect(result.ok).toBe(true);
    },
  );

  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId, "trainer");
      const result = await assignStaffRole(context, target.userId, "manager");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );
});

describe("listStaff — permission matrix (Full/Manage/View may list, Admissions/Finance refused)", () => {
  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager", "trainer"])(
    "allows %s to view the staff list",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      await createTargetStaff(academyId);
      const result = await listStaff(context);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.staff.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each<AcademyRole>(["admissions_officer", "finance_officer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const { context } = await setupAcademy(role);
      const result = await listStaff(context);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("never returns another academy's staff (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner");
    await createTargetStaff(other.academyId);

    const { context } = await setupAcademy("academy_owner");
    const result = await listStaff(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.staff.length).toBe(0);
  });

  it("includes the joined academy_memberships role and users.email (loginEmail)", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId, "finance_officer");

    const result = await listStaff(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.staff.find((s) => s.id === target.staffProfileId);
      expect(row?.role).toBe("finance_officer");
      expect(row?.loginEmail).toBeTruthy();
    }
  });
});
