import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  notificationPreferences,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { MANDATORY_NOTIFICATION_TEMPLATE_IDS, NOTIFICATION_TEMPLATE_IDS } from "./templates";
import { getNotificationPreferences, setNotificationPreference } from "./preferences";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Setup helpers — same shape/conventions as lib/academies/certificates.test.ts.
// ---------------------------------------------------------------------------

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `preferences-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Preferences Test Plan ${randomUUID()}`,
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
      name: `Preferences Test Academy ${randomUUID()}`,
      slug: `preferences-test-${randomUUID()}`,
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

interface AcademySetup {
  academyId: string;
  userId: string;
  context: AuthContext;
}

async function setupAcademy(role: AcademyRole = "academy_owner"): Promise<AcademySetup> {
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

afterAll(async () => {
  for (const academyId of createdAcademyIds) {
    await db.delete(notificationPreferences).where(eq(notificationPreferences.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  for (const userId of createdUserIds) {
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

const OPTIONAL_TEMPLATE_ID = NOTIFICATION_TEMPLATE_IDS.find(
  (id) => !MANDATORY_NOTIFICATION_TEMPLATE_IDS.has(id),
)!;
const MANDATORY_TEMPLATE_ID = [...MANDATORY_NOTIFICATION_TEMPLATE_IDS][0];

describe("getNotificationPreferences", () => {
  it("defaults every template to enabled when no rows exist", async () => {
    const { academyId, context } = await setupAcademy();

    const result = await getNotificationPreferences(context, academyId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preferences).toHaveLength(NOTIFICATION_TEMPLATE_IDS.length);
    expect(result.preferences.every((p) => p.enabled)).toBe(true);
  });

  it("marks the fixed mandatory set as mandatory and everything else as optional", async () => {
    const { academyId, context } = await setupAcademy();

    const result = await getNotificationPreferences(context, academyId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const preference of result.preferences) {
      expect(preference.mandatory).toBe(MANDATORY_NOTIFICATION_TEMPLATE_IDS.has(preference.templateId));
    }
  });

  it("reflects a stored disabled row for an optional template", async () => {
    const { academyId, context } = await setupAcademy();
    await setNotificationPreference(context, academyId, OPTIONAL_TEMPLATE_ID, false);

    const result = await getNotificationPreferences(context, academyId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.preferences.find((p) => p.templateId === OPTIONAL_TEMPLATE_ID);
    expect(row?.enabled).toBe(false);
  });

  it("refuses a caller-supplied academyId that isn't the caller's own academy", async () => {
    const { context } = await setupAcademy();
    const otherAcademyId = randomUUID();

    const result = await getNotificationPreferences(context, otherAcademyId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("setNotificationPreference", () => {
  it("upserts: a second call updates the same row instead of inserting a duplicate", async () => {
    const { academyId, userId, context } = await setupAcademy();

    const first = await setNotificationPreference(context, academyId, OPTIONAL_TEMPLATE_ID, false);
    expect(first.ok).toBe(true);
    const second = await setNotificationPreference(context, academyId, OPTIONAL_TEMPLATE_ID, true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.preference.enabled).toBe(true);

    const rows = await db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.academyId, academyId),
          eq(notificationPreferences.templateId, OPTIONAL_TEMPLATE_ID),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(true);
  });

  it("rejects disabling a mandatory template with a clean validation error, and never stores it disabled", async () => {
    const { academyId, userId, context } = await setupAcademy();

    const result = await setNotificationPreference(context, academyId, MANDATORY_TEMPLATE_ID, false);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("mandatory_template");

    const rows = await db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.academyId, academyId),
          eq(notificationPreferences.templateId, MANDATORY_TEMPLATE_ID),
        ),
      );
    // Either no row was written at all, or (defensively) any row that
    // exists is still enabled — a mandatory template must never be
    // persisted as disabled.
    expect(rows.every((row) => row.enabled)).toBe(true);
  });

  it("allows re-affirming a mandatory template as enabled (a no-op in effect)", async () => {
    const { academyId, context } = await setupAcademy();

    const result = await setNotificationPreference(context, academyId, MANDATORY_TEMPLATE_ID, true);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preference.enabled).toBe(true);
  });

  it("refuses a caller-supplied academyId that isn't the caller's own academy", async () => {
    const { context } = await setupAcademy();
    const otherAcademyId = randomUUID();

    const result = await setNotificationPreference(context, otherAcademyId, OPTIONAL_TEMPLATE_ID, false);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("rejects a templateId outside the fixed NOTIFICATION_TEMPLATE_IDS set", async () => {
    const { academyId, context } = await setupAcademy();

    const result = await setNotificationPreference(context, academyId, "not.a.real.template", false);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("notification_preferences table constraints", () => {
  it("enforces unique (user_id, academy_id, template_id) with NULLS NOT DISTINCT treating two nulls as equal", async () => {
    const userId = await createUser();

    await db.insert(notificationPreferences).values({
      userId,
      academyId: null,
      templateId: OPTIONAL_TEMPLATE_ID,
      enabled: true,
    });

    await expect(
      db.insert(notificationPreferences).values({
        userId,
        academyId: null,
        templateId: OPTIONAL_TEMPLATE_ID,
        enabled: false,
      }),
    ).rejects.toThrow();
  });

  it("enforces the user_id foreign key", async () => {
    await expect(
      db.insert(notificationPreferences).values({
        userId: randomUUID(),
        academyId: null,
        templateId: OPTIONAL_TEMPLATE_ID,
        enabled: true,
      }),
    ).rejects.toThrow();
  });

  it("enforces the academy_id foreign key when non-null", async () => {
    const userId = await createUser();

    await expect(
      db.insert(notificationPreferences).values({
        userId,
        academyId: randomUUID(),
        templateId: OPTIONAL_TEMPLATE_ID,
        enabled: true,
      }),
    ).rejects.toThrow();
  });
});
