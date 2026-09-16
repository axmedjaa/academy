import { randomUUID } from "node:crypto";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  auditLogs,
  subscriptionPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { getOnboardingChecklistStatus } from "./onboarding-checklist";

let ownerUserId: string;
let paidPlanId: string;
let freePlanId: string;

const createdAcademyIds: string[] = [];
const createdSubscriptionIds: string[] = [];
const createdPaymentIds: string[] = [];
const createdPlanIds: string[] = [];

async function createPlan(priceAmountCents: number): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Onboarding checklist test plan ${randomUUID()}`,
      priceAmountCents,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 1,
      maxStudents: 10,
      maxStaff: 5,
      maxCourses: 5,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  createdPlanIds.push(plan.id);
  return plan.id;
}

interface CreateAcademyOptions {
  approved?: boolean;
  profileComplete?: boolean;
}

async function createAcademy(opts: CreateAcademyOptions = {}): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Onboarding checklist test academy ${randomUUID()}`,
      slug: `onboarding-checklist-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
      approvedBy: opts.approved ? ownerUserId : undefined,
      approvedAt: opts.approved ? new Date() : undefined,
      // The five fields this item's checklist treats as "profile complete"
      // (see onboarding-checklist.ts's own top-of-file judgment-call
      // comment) — all left null unless the test explicitly asks for a
      // complete profile.
      address: opts.profileComplete ? "1 Main St" : undefined,
      phone: opts.profileComplete ? "+1-555-0100" : undefined,
      email: opts.profileComplete ? "contact@example.com" : undefined,
      primaryContactName: opts.profileComplete ? "Jane Doe" : undefined,
      primaryContactPhone: opts.profileComplete ? "+1-555-0101" : undefined,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function createSubscription(academyId: string, planId: string): Promise<string> {
  const [row] = await db
    .insert(academySubscriptions)
    .values({ academyId, planId, createdBy: ownerUserId })
    .returning({ id: academySubscriptions.id });
  createdSubscriptionIds.push(row.id);
  return row.id;
}

async function createPayment(
  academyId: string,
  subscriptionId: string,
  status: "pending" | "verified",
): Promise<void> {
  const [row] = await db
    .insert(subscriptionPayments)
    .values({
      academyId,
      subscriptionId,
      amountCents: 1000,
      currency: "USD",
      paymentMethod: "bank_transfer",
      receivedAt: new Date(),
      recordedBy: ownerUserId,
      verifiedBy: status === "verified" ? ownerUserId : undefined,
      status,
    })
    .returning({ id: subscriptionPayments.id });
  createdPaymentIds.push(row.id);
}

beforeAll(async () => {
  const [owner] = await db
    .insert(users)
    .values({
      email: `onboarding-checklist-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  ownerUserId = owner.id;

  paidPlanId = await createPlan(1000);
  freePlanId = await createPlan(0);
});

afterAll(async () => {
  if (createdAcademyIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(
        or(
          inArray(auditLogs.academyId, createdAcademyIds),
          inArray(auditLogs.entityId, createdAcademyIds),
        ),
      );
  }
  await db.delete(auditLogs).where(eq(auditLogs.actorUserId, ownerUserId));

  if (createdPaymentIds.length > 0) {
    await db.delete(subscriptionPayments).where(inArray(subscriptionPayments.id, createdPaymentIds));
  }
  if (createdSubscriptionIds.length > 0) {
    await db
      .delete(academySubscriptions)
      .where(inArray(academySubscriptions.id, createdSubscriptionIds));
  }
  if (createdAcademyIds.length > 0) {
    await db.delete(academies).where(inArray(academies.id, createdAcademyIds));
  }
  if (createdPlanIds.length > 0) {
    await db.delete(subscriptionPlans).where(inArray(subscriptionPlans.id, createdPlanIds));
  }
  await db.delete(users).where(eq(users.id, ownerUserId));
});

describe("getOnboardingChecklistStatus — id handling", () => {
  it("returns null for a malformed academy id", async () => {
    const result = await getOnboardingChecklistStatus("not-a-uuid");
    expect(result).toBeNull();
  });

  it("returns null for a well-formed id that doesn't exist", async () => {
    const result = await getOnboardingChecklistStatus(randomUUID());
    expect(result).toBeNull();
  });
});

describe("getOnboardingChecklistStatus — profile_complete", () => {
  it("is unsatisfied when the required profile fields are missing, and lists what's missing", async () => {
    const academyId = await createAcademy();
    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "profile_complete");
    expect(item?.satisfied).toBe(false);
    expect(item?.detail).toContain("Address");
    expect(item?.detail).toContain("Phone");
    expect(item?.detail).toContain("Primary contact name");
  });

  it("is satisfied once address/phone/email/primary contact name/primary contact phone are all set", async () => {
    const academyId = await createAcademy({ profileComplete: true });
    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "profile_complete");
    expect(item?.satisfied).toBe(true);
  });
});

describe("getOnboardingChecklistStatus — plan_selected", () => {
  it("is unsatisfied when the academy has no subscription at all", async () => {
    const academyId = await createAcademy();
    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "plan_selected");
    expect(item?.satisfied).toBe(false);
  });

  it("is satisfied once any subscription row exists (a plan is always assigned by registerAcademy)", async () => {
    const academyId = await createAcademy();
    await createSubscription(academyId, freePlanId);
    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "plan_selected");
    expect(item?.satisfied).toBe(true);
  });
});

describe("getOnboardingChecklistStatus — approved", () => {
  it("is unsatisfied before approveAcademy has run", async () => {
    const academyId = await createAcademy();
    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "approved");
    expect(item?.satisfied).toBe(false);
  });

  it("is satisfied once the academy has been approved", async () => {
    const academyId = await createAcademy({ approved: true });
    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "approved");
    expect(item?.satisfied).toBe(true);
  });
});

describe("getOnboardingChecklistStatus — payment_verified (the DESIGN.md deviation)", () => {
  it("is unsatisfied when there is no subscription to check payment against", async () => {
    const academyId = await createAcademy();
    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "payment_verified");
    expect(item?.satisfied).toBe(false);
  });

  it("is satisfied automatically for a free (zero-price) plan, with no payment recorded at all", async () => {
    const academyId = await createAcademy();
    await createSubscription(academyId, freePlanId);
    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "payment_verified");
    expect(item?.satisfied).toBe(true);
  });

  it("is unsatisfied for a paid plan with no payment recorded", async () => {
    const academyId = await createAcademy();
    const subscriptionId = await createSubscription(academyId, paidPlanId);
    void subscriptionId;
    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "payment_verified");
    expect(item?.satisfied).toBe(false);
    expect(item?.detail).toMatch(/no payment has been recorded/i);
  });

  /**
   * This is the exact scenario this item's brief calls out: DESIGN.md's
   * literal wording is "payment recorded", but activateAcademy
   * (lib/academies/lifecycle.ts) requires a VERIFIED payment. A merely
   * "pending" (recorded) payment must NOT satisfy this checklist item —
   * otherwise the widget would show all-green while Activate would still
   * fail with activateAcademy's payment_required error.
   */
  it("is unsatisfied for a paid plan whose only payment is pending (recorded but not verified)", async () => {
    const academyId = await createAcademy();
    const subscriptionId = await createSubscription(academyId, paidPlanId);
    await createPayment(academyId, subscriptionId, "pending");

    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "payment_verified");
    expect(item?.satisfied).toBe(false);
    expect(item?.detail).toMatch(/recorded but not yet verified/i);
  });

  it("is satisfied for a paid plan with a verified payment on file", async () => {
    const academyId = await createAcademy();
    const subscriptionId = await createSubscription(academyId, paidPlanId);
    await createPayment(academyId, subscriptionId, "verified");

    const status = await getOnboardingChecklistStatus(academyId);
    const item = status?.items.find((i) => i.key === "payment_verified");
    expect(item?.satisfied).toBe(true);
  });
});

describe("getOnboardingChecklistStatus — allSatisfied", () => {
  it("is false when any single item is unsatisfied", async () => {
    const academyId = await createAcademy({ approved: true, profileComplete: true });
    await createSubscription(academyId, paidPlanId);
    // No payment recorded at all -> payment_verified is the only failing item.
    const status = await getOnboardingChecklistStatus(academyId);
    expect(status?.allSatisfied).toBe(false);
  });

  it("is true only once every item is satisfied", async () => {
    const academyId = await createAcademy({ approved: true, profileComplete: true });
    const subscriptionId = await createSubscription(academyId, paidPlanId);
    await createPayment(academyId, subscriptionId, "verified");

    const status = await getOnboardingChecklistStatus(academyId);
    expect(status?.allSatisfied).toBe(true);
    expect(status?.items.every((item) => item.satisfied)).toBe(true);
  });
});
