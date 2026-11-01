import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  branches,
  notifications,
  platformMemberships,
  staffProfiles,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { resolveAuthContext, type AuthContext } from "@/lib/auth/auth-context";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";

// Storage is mocked: tests decide what the bucket reports.
const storage = vi.hoisted(() => ({
  sumObjectSizesByPrefix: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));
vi.mock("@/lib/storage/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage/client")>()),
  ...storage,
}));

import {
  checkAllowance,
  checkStorageAllowance,
  enforceStoredUploadWithinAllowance,
  getAcademyLimitStatus,
} from "./usage";
import {
  createSubscriptionPlan,
  getPlanSubscriberCounts,
  listOfferablePlans,
  movePlan,
  setPlanActive,
  updateSubscriptionPlan,
  type PlanInput,
} from "./plans";
import { changeAcademyPlan } from "./change-plan";
import { getAcademyEntitlements } from "./entitlements";
import { getLandingPlans } from "@/lib/marketing/landing";
import { updateStudent } from "@/lib/academies/students";
import { updateStaff } from "@/lib/academies/staff";
import { getFinanceReports } from "@/lib/academies/finance-reports";
import { getAcademicReports } from "@/lib/academies/academic-reports";
import { exportData } from "@/lib/export/export-data";
import { enqueueNotification } from "@/lib/notifications/notifications";

/**
 * Dynamic subscription plans (migration 0040): plan management, nullable
 * (unlimited) limits, restore and concurrency enforcement, storage, limit
 * reductions, Change plan, feature entitlements and landing consistency.
 */

const MARK = `plan-limits-${randomUUID().slice(0, 8)}`;
const userIds: string[] = [];
const academyIds: string[] = [];
const planIds: string[] = [];
let owner: AuthContext;
let admin: AuthContext;

async function user(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `${MARK}-${randomUUID().slice(0, 6)}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  userIds.push(row.id);
  return row.id;
}

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    name: `${MARK} plan ${randomUUID().slice(0, 6)}`,
    description: null,
    priceAmountCents: 4900,
    currency: "USD",
    billingPeriod: "monthly",
    maxBranches: 5,
    maxStudents: 100,
    maxStaff: 10,
    maxCourses: 10,
    maxStorageBytes: 2 * 1024 ** 3,
    smsEnabled: false,
    emailEnabled: true,
    exportsEnabled: true,
    advancedReportsEnabled: true,
    ...overrides,
  };
}

async function plan(overrides: Partial<typeof subscriptionPlans.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(subscriptionPlans)
    .values({
      name: `${MARK} fixture ${randomUUID().slice(0, 6)}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 10,
      maxStorageBytes: 1024 ** 3,
      reportsLevel: "basic",
      isActive: true,
      ...overrides,
    })
    .returning({ id: subscriptionPlans.id });
  planIds.push(row.id);
  return row.id;
}

/** An active academy on `planId`, with its owner and a Main Branch. */
async function academy(planId: string) {
  const ownerId = await user();
  const [row] = await db
    .insert(academies)
    .values({ name: `${MARK} academy`, slug: `${MARK}-${randomUUID().slice(0, 6)}`, defaultCurrency: "USD", createdBy: ownerId })
    .returning({ id: academies.id });
  academyIds.push(row.id);
  await db.insert(academySubscriptions).values({ academyId: row.id, planId, status: "active", createdBy: ownerId });
  await db.insert(academyMemberships).values({ userId: ownerId, academyId: row.id, role: "academy_owner", status: "active" });
  const [branch] = await db
    .insert(branches)
    .values({ academyId: row.id, name: "Main", code: `M-${randomUUID().slice(0, 6)}`, isMain: true })
    .returning({ id: branches.id });
  return { academyId: row.id, ownerId, branchId: branch.id, context: await resolveAuthContext(ownerId) };
}

async function student(academyId: string, branchId: string, createdBy: string, status: "active" | "archived" = "active") {
  const [row] = await db
    .insert(students)
    .values({ academyId, branchId, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Limit Student", status, createdBy })
    .returning({ id: students.id });
  return row.id;
}

async function staff(academyId: string, status: "active" | "archived" = "active") {
  const userId = await user();
  await db.insert(academyMemberships).values({ userId, academyId, role: "trainer", status: "active", academyWide: legacyAllBranchAccess("trainer") });
  const [row] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Limit Staff", phone: "+252 61 000 0000", status })
    .returning({ id: staffProfiles.id });
  return row.id;
}

beforeAll(async () => {
  const ownerId = await user();
  await db.insert(platformMemberships).values({ userId: ownerId, role: "platform_owner" });
  const adminId = await user();
  await db.insert(platformMemberships).values({ userId: adminId, role: "platform_admin" });
  owner = await resolveAuthContext(ownerId);
  admin = await resolveAuthContext(adminId);
}, 120_000);

beforeEach(() => {
  storage.sumObjectSizesByPrefix.mockReset();
  storage.headObject.mockReset();
  storage.deleteObject.mockReset();
  storage.sumObjectSizesByPrefix.mockResolvedValue({ ok: true, totalBytes: 0 });
  storage.headObject.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 10 } });
  storage.deleteObject.mockResolvedValue({ ok: true });
});

afterAll(async () => {
  await db.delete(notifications).where(inArray(notifications.academyId, academyIds));
  await db
    .delete(auditLogs)
    .where(or(inArray(auditLogs.actorUserId, userIds), inArray(auditLogs.academyId, academyIds), inArray(auditLogs.entityId, planIds)));
  await db.delete(students).where(inArray(students.academyId, academyIds));
  await db.delete(staffProfiles).where(inArray(staffProfiles.academyId, academyIds));
  await db.delete(branches).where(inArray(branches.academyId, academyIds));
  await db.delete(academySubscriptions).where(inArray(academySubscriptions.academyId, academyIds));
  await db.delete(academyMemberships).where(inArray(academyMemberships.academyId, academyIds));
  await db.delete(academies).where(inArray(academies.id, academyIds));
  await db.delete(subscriptionPlans).where(inArray(subscriptionPlans.id, planIds));
  await db.delete(platformMemberships).where(inArray(platformMemberships.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
}, 180_000);

describe("plan management (platform owner)", () => {
  it("creates priced plans as active and unpriced plans as retired; activation needs a price", { timeout: 90_000 }, async () => {
    const priced = await createSubscriptionPlan(owner, planInput());
    expect(priced.ok && priced.plan.isActive).toBe(true);
    if (priced.ok) planIds.push(priced.plan.id);

    const unpriced = await createSubscriptionPlan(owner, planInput({ priceAmountCents: null }));
    expect(unpriced.ok && unpriced.plan.isActive).toBe(false);
    if (!unpriced.ok) return;
    planIds.push(unpriced.plan.id);

    const activate = await setPlanActive(owner, unpriced.plan.id, true);
    expect(!activate.ok && activate.error.code).toBe("validation");

    const repriced = await updateSubscriptionPlan(owner, unpriced.plan.id, planInput({ name: unpriced.plan.name, priceAmountCents: 12900 }));
    expect(repriced.ok && repriced.plan.priceAmountCents).toBe(12900);
    expect((await setPlanActive(owner, unpriced.plan.id, true)).ok).toBe(true);

    // An active plan can't lose its price.
    const unprice = await updateSubscriptionPlan(owner, unpriced.plan.id, planInput({ priceAmountCents: null }));
    expect(!unprice.ok && unprice.error.code).toBe("validation");

    const audits = await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, unpriced.plan.id));
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(["createSubscriptionPlan", "updateSubscriptionPlan", "setPlanActive"]));
  });

  it("stores unlimited limits as null and enforces them as no limit", { timeout: 90_000 }, async () => {
    const created = await createSubscriptionPlan(owner, planInput({ maxStudents: null, maxStorageBytes: null }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    planIds.push(created.plan.id);
    expect(created.plan.maxStudents).toBeNull();

    const a = await academy(created.plan.id);
    for (let i = 0; i < 3; i++) await student(a.academyId, a.branchId, a.ownerId);
    const allowance = await db.transaction((tx) => checkAllowance(a.academyId, "students", tx));
    expect(allowance.ok && allowance.result).toMatchObject({ allowed: true, limit: null, current: 3 });

    const store = await checkStorageAllowance(a.academyId, 10 * 1024 ** 3);
    expect(store).toMatchObject({ ok: true, allowed: true, limitBytes: null });
  });

  it("only the platform owner can create, edit, activate or reorder plans", { timeout: 60_000 }, async () => {
    const planId = await plan();
    expect((await createSubscriptionPlan(admin, planInput())).ok).toBe(false);
    expect((await updateSubscriptionPlan(admin, planId, planInput())).ok).toBe(false);
    expect((await setPlanActive(admin, planId, false)).ok).toBe(false);
    expect((await movePlan(admin, planId, "up")).ok).toBe(false);
    const a = await academy(planId);
    expect((await createSubscriptionPlan(a.context, planInput())).ok).toBe(false);
  });

  it("reorders plans and counts current subscribers per plan", { timeout: 120_000 }, async () => {
    const first = await plan();
    const second = await plan();
    await academy(second);
    await academy(second);
    const counts = await getPlanSubscriberCounts([first, second]);
    expect(counts[second]).toBe(2);
    expect(counts[first] ?? 0).toBe(0);

    // Position in the full display order (sort_order, then creation).
    const position = async (id: string) => {
      const ordered = await db
        .select({ id: subscriptionPlans.id })
        .from(subscriptionPlans)
        .orderBy(subscriptionPlans.sortOrder, subscriptionPlans.createdAt, subscriptionPlans.id);
      return ordered.findIndex((row) => row.id === id);
    };
    const before = await position(second);
    expect((await movePlan(owner, second, "up")).ok).toBe(true);
    expect(await position(second)).toBe(before - 1);
    const [audit] = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, second), eq(auditLogs.action, "reorderSubscriptionPlan")));
    expect(audit).toBeDefined();
  });
});

describe("limit enforcement", () => {
  it("restoring an archived student rechecks the student limit; archived students don't count", { timeout: 90_000 }, async () => {
    const a = await academy(await plan({ maxStudents: 1 }));
    const active = await student(a.academyId, a.branchId, a.ownerId);
    const archived = await student(a.academyId, a.branchId, a.ownerId, "archived");

    const blocked = await updateStudent(a.context, archived, { fullName: "Limit Student", status: "active" });
    expect(!blocked.ok && blocked.error.code).toBe("allowance");
    const [still] = await db.select({ status: students.status }).from(students).where(eq(students.id, archived));
    expect(still.status).toBe("archived");

    expect((await updateStudent(a.context, active, { fullName: "Limit Student", status: "archived" })).ok).toBe(true);
    expect((await updateStudent(a.context, archived, { fullName: "Limit Student", status: "active" })).ok).toBe(true);
  });

  it("restoring archived staff rechecks the staff limit", { timeout: 90_000 }, async () => {
    const a = await academy(await plan({ maxStaff: 1 }));
    const active = await staff(a.academyId);
    const archived = await staff(a.academyId, "archived");

    const blocked = await updateStaff(a.context, archived, { fullName: "Limit Staff", phone: "+252 61 000 0000", status: "active" });
    expect(!blocked.ok && blocked.error.code).toBe("allowance_exceeded");

    expect((await updateStaff(a.context, active, { fullName: "Limit Staff", phone: "+252 61 000 0000", status: "archived" })).ok).toBe(true);
    expect((await updateStaff(a.context, archived, { fullName: "Limit Staff", phone: "+252 61 000 0000", status: "active" })).ok).toBe(true);
  });

  it("concurrent creates can't pass the limit together (per-academy lock)", { timeout: 120_000 }, async () => {
    const a = await academy(await plan({ maxStudents: 3 }));
    await student(a.academyId, a.branchId, a.ownerId);
    await student(a.academyId, a.branchId, a.ownerId);
    // Two slots taken, one left: five simultaneous check-then-insert transactions.
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        db.transaction(async (tx) => {
          const allowance = await checkAllowance(a.academyId, "students", tx);
          if (!allowance.ok || !allowance.result.allowed) return false;
          await tx.insert(students).values({
            academyId: a.academyId,
            branchId: a.branchId,
            studentNumber: `STD-${randomUUID().slice(0, 8)}`,
            fullName: "Concurrent",
            createdBy: a.ownerId,
          });
          return true;
        }),
      ),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const [{ n }] = await db
      .select({ n: db.$count(students, and(eq(students.academyId, a.academyId), eq(students.status, "active"))) })
      .from(academies)
      .where(eq(academies.id, a.academyId));
    expect(n).toBe(3);
  });

  it("storage: refuses uploads past the allowance, fails closed, and deletes an over-limit upload", { timeout: 60_000 }, async () => {
    const a = await academy(await plan({ maxStorageBytes: 2 * 1024 ** 3 }));

    storage.sumObjectSizesByPrefix.mockResolvedValue({ ok: true, totalBytes: 1.9 * 1024 ** 3 });
    expect(await checkStorageAllowance(a.academyId, 50 * 1024 ** 2)).toMatchObject({ ok: true, allowed: true });
    expect(await checkStorageAllowance(a.academyId, 200 * 1024 ** 2)).toMatchObject({ ok: true, allowed: false });

    storage.sumObjectSizesByPrefix.mockResolvedValue({ ok: false, error: "unreachable" });
    const unknown = await checkStorageAllowance(a.academyId, 1);
    expect(!unknown.ok && unknown.error.code).toBe("unavailable");

    const key = `academies/${a.academyId}/logos/${randomUUID()}.png`;
    storage.sumObjectSizesByPrefix.mockResolvedValue({ ok: true, totalBytes: 2 * 1024 ** 3 + 1 });
    const over = await enforceStoredUploadWithinAllowance(a.academyId, key);
    expect(over.ok).toBe(false);
    expect(storage.deleteObject).toHaveBeenCalledWith(key);

    storage.deleteObject.mockClear();
    storage.sumObjectSizesByPrefix.mockResolvedValue({ ok: true, totalBytes: 1024 });
    expect((await enforceStoredUploadWithinAllowance(a.academyId, key)).ok).toBe(true);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});

describe("lowering limits and changing plans", () => {
  it("lowering a limit below usage needs confirmation, keeps data, and blocks new creates", { timeout: 120_000 }, async () => {
    const created = await createSubscriptionPlan(owner, planInput({ maxStudents: 10 }));
    if (!created.ok) throw new Error("plan not created");
    planIds.push(created.plan.id);
    const a = await academy(created.plan.id);
    for (let i = 0; i < 4; i++) await student(a.academyId, a.branchId, a.ownerId);

    const lowered = planInput({ name: created.plan.name, maxStudents: 2 });
    const attempt = await updateSubscriptionPlan(owner, created.plan.id, lowered);
    expect(!attempt.ok && attempt.error.code).toBe("confirmation_required");
    if (!attempt.ok) {
      expect(attempt.error.impact).toEqual([
        expect.objectContaining({ academyId: a.academyId, resource: "students", current: 4, newLimit: 2 }),
      ]);
    }
    const [unchanged] = await db.select({ maxStudents: subscriptionPlans.maxStudents }).from(subscriptionPlans).where(eq(subscriptionPlans.id, created.plan.id));
    expect(unchanged.maxStudents).toBe(10);

    const confirmed = await updateSubscriptionPlan(owner, created.plan.id, { ...lowered, confirmLimitReduction: true });
    expect(confirmed.ok).toBe(true);

    const kept = await db.select({ id: students.id }).from(students).where(eq(students.academyId, a.academyId));
    expect(kept).toHaveLength(4);
    const [subscription] = await db.select({ status: academySubscriptions.status }).from(academySubscriptions).where(eq(academySubscriptions.academyId, a.academyId));
    expect(subscription.status).toBe("active");

    const allowance = await db.transaction((tx) => checkAllowance(a.academyId, "students", tx));
    expect(allowance.ok && allowance.result.allowed).toBe(false);
    const status = await getAcademyLimitStatus(a.academyId);
    expect(status?.rows.find((row) => row.resource === "students")).toMatchObject({ current: 4, limit: 2, over: true });

    const [audit] = await db
      .select({ context: auditLogs.context })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.plan.id), eq(auditLogs.action, "updateSubscriptionPlan")));
    expect(audit.context).toMatchObject({ limitReductionConfirmed: true });
  });

  it("Change plan: owner only, active priced plans only, immediate, audited, nothing charged", { timeout: 120_000 }, async () => {
    const from = await plan({ maxStudents: 100 });
    const to = await plan({ maxStudents: 1 });
    const retired = await plan({ isActive: false });
    const a = await academy(from);
    await student(a.academyId, a.branchId, a.ownerId);
    await student(a.academyId, a.branchId, a.ownerId);

    expect((await changeAcademyPlan(admin, a.academyId, to)).ok).toBe(false);
    expect((await changeAcademyPlan(a.context, a.academyId, to)).ok).toBe(false);
    const refused = await changeAcademyPlan(owner, a.academyId, retired);
    expect(!refused.ok && refused.error.code).toBe("validation");

    const changed = await changeAcademyPlan(owner, a.academyId, to);
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.overLimit.map((row) => row.resource)).toEqual(["students"]);
    const subs = await db.select({ planId: academySubscriptions.planId }).from(academySubscriptions).where(eq(academySubscriptions.academyId, a.academyId));
    expect(subs).toEqual([{ planId: to }]);
    const [audit] = await db
      .select({ before: auditLogs.before, after: auditLogs.after })
      .from(auditLogs)
      .where(and(eq(auditLogs.academyId, a.academyId), eq(auditLogs.action, "changeAcademyPlan")));
    expect(audit).toMatchObject({ before: { planId: from }, after: { planId: to } });
  });
});

describe("feature entitlements", () => {
  it("advanced reports, exports and email follow the plan, server-side", { timeout: 120_000 }, async () => {
    const basic = await academy(
      await plan({ advancedReportsEnabled: false, exportsEnabled: false, emailEnabled: false, smsEnabled: false }),
    );
    expect(await getAcademyEntitlements(basic.academyId)).toEqual({ sms: false, email: false, advancedReports: false, exports: false });

    const finance = await getFinanceReports(basic.context);
    expect(!finance.ok && finance.error.code).toBe("feature_unavailable");
    const academic = await getAcademicReports(basic.context);
    expect(!academic.ok && academic.error.code).toBe("feature_unavailable");
    const exported = await exportData(basic.context, "student_list", {});
    expect(!exported.ok && exported.error.code).toBe("feature_unavailable");

    const channels = await enqueueNotification({
      eventType: "certificate.issued",
      entityId: randomUUID(),
      templateId: "certificate.issued",
      academyId: basic.academyId,
      userId: basic.ownerId,
    });
    expect(channels.map((row) => row.channel)).toEqual(["in_app"]);

    const full = await academy(await plan({ smsEnabled: true }));
    expect((await getFinanceReports(full.context)).ok).toBe(true);
    expect((await exportData(full.context, "student_list", {})).ok).toBe(true);
    const fullChannels = await enqueueNotification({
      eventType: "certificate.issued",
      entityId: randomUUID(),
      templateId: "certificate.issued",
      academyId: full.academyId,
      userId: full.ownerId,
    });
    expect(fullChannels.map((row) => row.channel).sort()).toEqual(["email", "in_app", "sms"]);
  });
});

describe("landing page pricing", () => {
  it("shows only active, priced plans with the values the server enforces", { timeout: 90_000 }, async () => {
    const shown = await plan({ maxCourses: null, advancedReportsEnabled: false, smsEnabled: true });
    const retired = await plan({ isActive: false });
    const unpriced = await plan({ isActive: false, priceAmountCents: null });

    const offered = (await listOfferablePlans()).map((row) => row.id);
    expect(offered).toContain(shown);
    expect(offered).not.toContain(retired);
    expect(offered).not.toContain(unpriced);

    const card = (await getLandingPlans()).find((row) => row.id === shown);
    expect(card).toMatchObject({ priceAmountCents: 1000, limits: { maxCourses: null, maxStudents: 100 } });
    expect(card?.features).toEqual(["sms", "email", "exports"]);
  });
});
