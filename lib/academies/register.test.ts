import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  auditLogs,
  branches,
  platformMemberships,
  users,
} from "@/lib/db/schema";
import { resolveAuthContext } from "@/lib/auth/auth-context";
import { registerAcademy, type RegisterAcademyInput } from "./register";

let ownerUserId: string;
let adminUserId: string;
let plainUserId: string;

// academyIds created by successful registerAcademy calls in this file —
// cleaned up (along with their branch/membership/owner rows) in afterEach.
const createdAcademyIds: string[] = [];
// Extra "owner" users created directly by tests (e.g. to pre-occupy an
// email) that aren't tied to a created academy.
const extraUserIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `register-academy-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

function baseInput(overrides: Partial<RegisterAcademyInput> = {}): RegisterAcademyInput {
  const unique = randomUUID();
  return {
    name: `Test Academy ${unique}`,
    defaultCurrency: "usd",
    ownerEmail: `owner-${unique}@example.com`,
    ownerPassword: "a-valid-password-123",
    branchName: "Main Branch",
    branchCode: "MAIN",
    ...overrides,
  };
}

/**
 * Cleans up everything a successful registerAcademy call created. Ordering
 * matters: audit_logs carries a real FK to both users.id (actor_user_id) and
 * academies.id (academy_id) — as prior Wave 1 agents found the hard way,
 * those rows must be deleted before the academies/users rows they
 * reference, or the delete fails with a foreign-key violation.
 */
async function cleanupAcademy(academyId: string, ownerId: string): Promise<void> {
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.academyId, academyId), eq(auditLogs.actorUserId, ownerId)));
  await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
  await db.delete(branches).where(eq(branches.academyId, academyId));
  await db.delete(academies).where(eq(academies.id, academyId));
  await db.delete(platformMemberships).where(eq(platformMemberships.userId, ownerId));
  await db.delete(users).where(eq(users.id, ownerId));
}

async function cleanupUser(userId: string): Promise<void> {
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.actorUserId, userId), eq(auditLogs.entityId, userId)));
  await db.delete(academyMemberships).where(eq(academyMemberships.userId, userId));
  await db.delete(platformMemberships).where(eq(platformMemberships.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

beforeAll(async () => {
  ownerUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: ownerUserId, role: "platform_owner" });

  adminUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: adminUserId, role: "platform_admin" });

  plainUserId = await createUser();
});

afterEach(async () => {
  for (const academyId of createdAcademyIds.splice(0)) {
    const [academy] = await db
      .select({ id: academies.id })
      .from(academies)
      .where(eq(academies.id, academyId));
    if (!academy) continue;

    const [membership] = await db
      .select({ userId: academyMemberships.userId })
      .from(academyMemberships)
      .where(eq(academyMemberships.academyId, academyId));

    await cleanupAcademy(academyId, membership?.userId ?? "");
  }
  for (const userId of extraUserIds.splice(0)) {
    await cleanupUser(userId);
  }
});

afterAll(async () => {
  await cleanupUser(ownerUserId);
  await cleanupUser(adminUserId);
  await cleanupUser(plainUserId);
});

describe("registerAcademy — authorization", () => {
  it("refuses when the actor is a platform_admin (not platform_owner), even with no grants checked", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await registerAcademy(adminContext, baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("refuses for a context with no platform role at all", async () => {
    const plainContext = await resolveAuthContext(plainUserId);
    const result = await registerAcademy(plainContext, baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });
});

describe("registerAcademy — validation", () => {
  it("rejects a missing academy name", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ name: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects a currency that isn't a 3-letter code", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ defaultCurrency: "dollars" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects an owner password shorter than 12 characters", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ ownerPassword: "short1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects a missing default branch code", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ branchCode: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });
});

describe("registerAcademy — success path", () => {
  it("creates the academy, a default branch, the owner account, and the academy_owner membership in one transaction", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const input = baseInput();
    const result = await registerAcademy(ownerContext, input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);

    const [academy] = await db
      .select()
      .from(academies)
      .where(eq(academies.id, result.academyId));
    expect(academy?.name).toBe(input.name);
    expect(academy?.defaultCurrency).toBe("USD");
    expect(academy?.createdBy).toBe(ownerUserId);
    expect(academy?.approvedAt).toBeNull();
    expect(academy?.closedAt).toBeNull();
    expect(academy?.slug).toBeTruthy();

    const [branch] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, result.branchId));
    expect(branch?.academyId).toBe(result.academyId);
    expect(branch?.name).toBe("Main Branch");
    expect(branch?.code).toBe("MAIN");

    const [ownerUserRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, result.ownerUserId));
    expect(ownerUserRow?.email).toBe(input.ownerEmail);

    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(eq(academyMemberships.userId, result.ownerUserId));
    expect(membership?.academyId).toBe(result.academyId);
    expect(membership?.role).toBe("academy_owner");
    expect(membership?.status).toBe("active");
  });

  it("writes a registerAcademy audit_logs row in the same transaction", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const input = baseInput();
    const result = await registerAcademy(ownerContext, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.academyId, result.academyId));
    expect(audit?.action).toBe("registerAcademy");
    expect(audit?.entityType).toBe("academy");
    expect(audit?.entityId).toBe(result.academyId);
    expect(audit?.actorUserId).toBe(ownerUserId);
    expect(audit?.result).toBe("success");
  });

  it("normalizes blank optional profile fields to null rather than empty strings", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const input = baseInput({ type: "", address: "", website: "" });
    const result = await registerAcademy(ownerContext, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);

    const [academy] = await db
      .select()
      .from(academies)
      .where(eq(academies.id, result.academyId));
    expect(academy?.type).toBeNull();
    expect(academy?.address).toBeNull();
    expect(academy?.website).toBeNull();
  });

  it("refuses when the owner email is already in use by an existing account", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const takenEmail = `taken-${randomUUID()}@example.com`;
    const existingId = await createUser();
    extraUserIds.push(existingId);
    await db.update(users).set({ email: takenEmail }).where(eq(users.id, existingId));

    const result = await registerAcademy(ownerContext, baseInput({ ownerEmail: takenEmail }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("owner_email_taken");
    }
  });

  it("assigns a unique slug when two academies share the same name", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const sharedName = `Duplicate Name Academy ${randomUUID()}`;

    const first = await registerAcademy(ownerContext, baseInput({ name: sharedName }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    createdAcademyIds.push(first.academyId);

    const second = await registerAcademy(ownerContext, baseInput({ name: sharedName }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    createdAcademyIds.push(second.academyId);

    const [firstAcademy] = await db
      .select({ slug: academies.slug })
      .from(academies)
      .where(eq(academies.id, first.academyId));
    const [secondAcademy] = await db
      .select({ slug: academies.slug })
      .from(academies)
      .where(eq(academies.id, second.academyId));

    expect(firstAcademy?.slug).not.toBe(secondAcademy?.slug);
  });
});
