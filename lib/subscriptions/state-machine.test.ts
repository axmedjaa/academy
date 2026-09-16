import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import {
  computeLazySubscriptionStatus,
  GRACE_PERIOD_DAYS,
  initialSubscriptionStatus,
  isTerminalSubscriptionStatus,
  SUBSCRIPTION_STATUSES,
  transitionSubscriptionState,
  type SubscriptionStatus,
  type SubscriptionTransitionEvent,
} from "./state-machine";

const DAY_MS = 24 * 60 * 60 * 1000;

let ownerUserId: string;
let academyId: string;
let planId: string;
const createdSubscriptionIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `sub-state-machine-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

beforeAll(async () => {
  ownerUserId = await createUser();

  const [academy] = await db
    .insert(academies)
    .values({
      name: `Test Academy ${randomUUID()}`,
      slug: `test-academy-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  academyId = academy.id;

  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Test plan ${randomUUID()}`,
      priceAmountCents: 1000,
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
  planId = plan.id;
});

afterAll(async () => {
  if (createdSubscriptionIds.length > 0) {
    await db
      .delete(academySubscriptions)
      .where(inArray(academySubscriptions.id, createdSubscriptionIds));
  }
  // No audit_logs rows are created by this test file (no server action /
  // recordAudit() call is exercised here — pure schema + state-machine
  // logic only), so no audit_logs cleanup step is needed before deleting
  // the academy/plan/user rows below.
  await db.delete(academies).where(eq(academies.id, academyId));
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  await db.delete(users).where(eq(users.id, ownerUserId));
});

// ---------------------------------------------------------------------------
// transitionSubscriptionState — every listed transition accepted, every
// unlisted transition rejected (PLAN.md Phase 1 §8: "every transition in the
// table above accepted, every unlisted transition rejected").
// ---------------------------------------------------------------------------

const LISTED_TRANSITIONS: Array<{
  from: SubscriptionStatus;
  event: SubscriptionTransitionEvent;
  to: SubscriptionStatus;
}> = [
  { from: "draft", event: "start_trial", to: "trial" },
  { from: "draft", event: "activate", to: "active" },
  { from: "trial", event: "activate", to: "active" },
  { from: "trial", event: "cancel", to: "cancelled" },
  { from: "active", event: "cancel", to: "cancelled" },
  { from: "past_due", event: "cancel", to: "cancelled" },
  { from: "suspended", event: "cancel", to: "cancelled" },
  { from: "expired", event: "cancel", to: "cancelled" },
  { from: "active", event: "renew", to: "active" },
  { from: "past_due", event: "renew", to: "active" },
  { from: "suspended", event: "renew", to: "active" },
  { from: "expired", event: "renew", to: "active" },
];

describe("transitionSubscriptionState — listed transitions", () => {
  it.each(LISTED_TRANSITIONS)(
    "$event: $from -> $to is accepted",
    ({ from, event, to }) => {
      const result = transitionSubscriptionState(from, event);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe(to);
      }
    },
  );
});

describe("transitionSubscriptionState — every unlisted transition is rejected", () => {
  const events: SubscriptionTransitionEvent[] = [
    "start_trial",
    "activate",
    "renew",
    "cancel",
  ];
  const listedKey = (from: SubscriptionStatus, event: SubscriptionTransitionEvent) =>
    `${from}:${event}`;
  const listedSet = new Set(
    LISTED_TRANSITIONS.map(({ from, event }) => listedKey(from, event)),
  );

  const unlistedCases: Array<{
    from: SubscriptionStatus;
    event: SubscriptionTransitionEvent;
  }> = [];
  for (const from of SUBSCRIPTION_STATUSES) {
    for (const event of events) {
      if (!listedSet.has(listedKey(from, event))) {
        unlistedCases.push({ from, event });
      }
    }
  }

  // Sanity: this exhaustive sweep must actually cover more than the listed
  // rows, otherwise the "rejected" half of this test would be vacuous.
  it("has at least one unlisted case to check", () => {
    expect(unlistedCases.length).toBeGreaterThan(0);
  });

  it.each(unlistedCases)(
    "$event from $from is rejected",
    ({ from, event }) => {
      const result = transitionSubscriptionState(from, event);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_transition");
      }
    },
  );

  it("specifically rejects cancelling a Draft subscription (Draft is not in the 'any of' cancel row)", () => {
    const result = transitionSubscriptionState("draft", "cancel");
    expect(result.ok).toBe(false);
  });

  it("specifically rejects re-transitioning out of Cancelled (terminal)", () => {
    for (const event of events) {
      const result = transitionSubscriptionState("cancelled", event);
      expect(result.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// computeLazySubscriptionStatus — Trial -> Expired and the 7-day grace
// computation for Active -> Past Due -> Suspended.
// ---------------------------------------------------------------------------

describe("computeLazySubscriptionStatus — Trial -> Expired", () => {
  it("stays Trial before trial_ends_at", () => {
    const trialEndsAt = new Date(Date.now() + DAY_MS);
    const status = computeLazySubscriptionStatus(
      { status: "trial", trialEndsAt, endsAt: null },
      new Date(),
    );
    expect(status).toBe("trial");
  });

  it("flips to Expired once trial_ends_at has passed", () => {
    const trialEndsAt = new Date(Date.now() - DAY_MS);
    const status = computeLazySubscriptionStatus(
      { status: "trial", trialEndsAt, endsAt: null },
      new Date(),
    );
    expect(status).toBe("expired");
  });

  it("stays Trial indefinitely with no trial_ends_at set", () => {
    const status = computeLazySubscriptionStatus(
      { status: "trial", trialEndsAt: null, endsAt: null },
      new Date(),
    );
    expect(status).toBe("trial");
  });
});

describe("computeLazySubscriptionStatus — Active -> Past Due -> Suspended", () => {
  it("stays Active before ends_at", () => {
    const endsAt = new Date(Date.now() + DAY_MS);
    const status = computeLazySubscriptionStatus(
      { status: "active", trialEndsAt: null, endsAt },
      new Date(),
    );
    expect(status).toBe("active");
  });

  it("becomes Past Due just after ends_at", () => {
    const now = new Date();
    const endsAt = new Date(now.getTime() - 1000);
    const status = computeLazySubscriptionStatus(
      { status: "active", trialEndsAt: null, endsAt },
      now,
    );
    expect(status).toBe("past_due");
  });

  it("stays Past Due within the 7-day grace window", () => {
    const now = new Date();
    const endsAt = new Date(now.getTime() - (GRACE_PERIOD_DAYS * DAY_MS - DAY_MS));
    const status = computeLazySubscriptionStatus(
      { status: "past_due", trialEndsAt: null, endsAt },
      now,
    );
    expect(status).toBe("past_due");
  });

  it("is Past Due exactly at the grace deadline (boundary is inclusive)", () => {
    const now = new Date();
    const endsAt = new Date(now.getTime() - GRACE_PERIOD_DAYS * DAY_MS);
    const status = computeLazySubscriptionStatus(
      { status: "past_due", trialEndsAt: null, endsAt },
      now,
    );
    expect(status).toBe("past_due");
  });

  it("becomes Suspended once the 7-day grace period elapses", () => {
    const now = new Date();
    const endsAt = new Date(now.getTime() - (GRACE_PERIOD_DAYS * DAY_MS + 1000));
    const status = computeLazySubscriptionStatus(
      { status: "past_due", trialEndsAt: null, endsAt },
      now,
    );
    expect(status).toBe("suspended");
  });

  it("jumps a long-dormant Active row straight to Suspended without an intermediate stored Past Due", () => {
    const now = new Date();
    const endsAt = new Date(now.getTime() - 30 * DAY_MS);
    const status = computeLazySubscriptionStatus(
      { status: "active", trialEndsAt: null, endsAt },
      now,
    );
    expect(status).toBe("suspended");
  });

  it("stays Active indefinitely with no ends_at set", () => {
    const status = computeLazySubscriptionStatus(
      { status: "active", trialEndsAt: null, endsAt: null },
      new Date(),
    );
    expect(status).toBe("active");
  });
});

describe("computeLazySubscriptionStatus — time-invariant statuses", () => {
  it.each(["draft", "suspended", "expired", "cancelled"] as SubscriptionStatus[])(
    "%s never changes regardless of dates or now",
    (status) => {
      const result = computeLazySubscriptionStatus(
        {
          status,
          trialEndsAt: new Date(Date.now() - 100 * DAY_MS),
          endsAt: new Date(Date.now() - 100 * DAY_MS),
        },
        new Date(Date.now() + 100 * DAY_MS),
      );
      expect(result).toBe(status);
    },
  );
});

// ---------------------------------------------------------------------------
// initialSubscriptionStatus / isTerminalSubscriptionStatus
// ---------------------------------------------------------------------------

describe("initialSubscriptionStatus", () => {
  it("starts in Trial when a trial_ends_at is given", () => {
    expect(
      initialSubscriptionStatus({ trialEndsAt: new Date(Date.now() + DAY_MS) }),
    ).toBe("trial");
  });

  it("starts in Draft when there is no trial", () => {
    expect(initialSubscriptionStatus({ trialEndsAt: null })).toBe("draft");
    expect(initialSubscriptionStatus({ trialEndsAt: undefined })).toBe("draft");
  });
});

describe("isTerminalSubscriptionStatus", () => {
  it("is true only for Cancelled", () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(isTerminalSubscriptionStatus(status)).toBe(status === "cancelled");
    }
  });
});

// ---------------------------------------------------------------------------
// Schema-level checks against the real academy_subscriptions table (Item 23
// is a migration too, not just pure logic) — defaults, and the two
// starts_at-anchored check constraints from Database Constraints & Indexes.
// ---------------------------------------------------------------------------

describe("academy_subscriptions table", () => {
  it("defaults status to draft and starts_at to now", async () => {
    const before = Date.now();
    const [row] = await db
      .insert(academySubscriptions)
      .values({ academyId, planId, createdBy: ownerUserId })
      .returning();
    createdSubscriptionIds.push(row.id);
    const after = Date.now();

    expect(row.status).toBe("draft");
    expect(row.startsAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.startsAt.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(row.endsAt).toBeNull();
    expect(row.trialEndsAt).toBeNull();
  });

  it("round-trips every column on an explicit insert", async () => {
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + 30 * DAY_MS);
    const trialEndsAt = new Date(startsAt.getTime() + 14 * DAY_MS);

    const [row] = await db
      .insert(academySubscriptions)
      .values({
        academyId,
        planId,
        status: "trial",
        startsAt,
        endsAt,
        trialEndsAt,
        createdBy: ownerUserId,
        updatedBy: ownerUserId,
        notes: "created by state-machine.test.ts",
      })
      .returning();
    createdSubscriptionIds.push(row.id);

    expect(row.academyId).toBe(academyId);
    expect(row.planId).toBe(planId);
    expect(row.status).toBe("trial");
    expect(row.endsAt?.getTime()).toBe(endsAt.getTime());
    expect(row.trialEndsAt?.getTime()).toBe(trialEndsAt.getTime());
    expect(row.createdBy).toBe(ownerUserId);
    expect(row.updatedBy).toBe(ownerUserId);
    expect(row.notes).toBe("created by state-machine.test.ts");
  });

  it("rejects ends_at before starts_at (DB check constraint)", async () => {
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() - DAY_MS);

    await expect(
      db.insert(academySubscriptions).values({
        academyId,
        planId,
        startsAt,
        endsAt,
        createdBy: ownerUserId,
      }),
    ).rejects.toThrow();
  });

  it("rejects trial_ends_at before starts_at (DB check constraint)", async () => {
    const startsAt = new Date();
    const trialEndsAt = new Date(startsAt.getTime() - DAY_MS);

    await expect(
      db.insert(academySubscriptions).values({
        academyId,
        planId,
        startsAt,
        trialEndsAt,
        createdBy: ownerUserId,
      }),
    ).rejects.toThrow();
  });

  it("allows ends_at/trial_ends_at equal to starts_at (inclusive boundary)", async () => {
    const startsAt = new Date();
    const [row] = await db
      .insert(academySubscriptions)
      .values({
        academyId,
        planId,
        startsAt,
        endsAt: startsAt,
        trialEndsAt: startsAt,
        createdBy: ownerUserId,
      })
      .returning();
    createdSubscriptionIds.push(row.id);
    expect(row.endsAt?.getTime()).toBe(startsAt.getTime());
  });
});
