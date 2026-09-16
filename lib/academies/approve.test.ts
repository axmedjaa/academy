import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { academies, auditLogs, platformMemberships, users } from "@/lib/db/schema";
import { resolveAuthContext } from "@/lib/auth/auth-context";
import {
  approveAcademy,
  getAcademyById,
  listAcademies,
} from "./approve";

let ownerUserId: string;
let adminUserId: string;
let plainUserId: string;
const createdAcademyIds: string[] = [];
const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `approve-academy-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

async function createAcademy(createdBy: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Test Academy ${randomUUID()}`,
      slug: `test-academy-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy,
    })
    .returning({ id: academies.id });
  return academy.id;
}

async function cleanupAcademy(academyId: string): Promise<void> {
  // audit_logs.entity_id/academy_id carry real FKs to academies.id — those
  // rows must go before the academy row can be deleted (bit a prior Wave 1
  // agent per this item's brief).
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.academyId, academyId), eq(auditLogs.entityId, academyId)));
  await db.delete(academies).where(eq(academies.id, academyId));
}

async function cleanupUser(userId: string): Promise<void> {
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.actorUserId, userId), eq(auditLogs.entityId, userId)));
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

afterAll(async () => {
  for (const academyId of createdAcademyIds) {
    await cleanupAcademy(academyId);
  }
  for (const userId of createdUserIds) {
    await cleanupUser(userId);
  }
  await cleanupUser(ownerUserId);
  await cleanupUser(adminUserId);
  await cleanupUser(plainUserId);
});

describe("approveAcademy — authorization", () => {
  it("refuses when the actor is a platform_admin (not platform_owner)", async () => {
    const academyId = await createAcademy(ownerUserId);
    createdAcademyIds.push(academyId);

    const adminContext = await resolveAuthContext(adminUserId);
    const result = await approveAcademy(adminContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }

    const [row] = await db
      .select({ approvedAt: academies.approvedAt })
      .from(academies)
      .where(eq(academies.id, academyId));
    expect(row?.approvedAt).toBeNull();
  });

  it("refuses for a plain user with no platform role", async () => {
    const academyId = await createAcademy(ownerUserId);
    createdAcademyIds.push(academyId);

    const plainContext = await resolveAuthContext(plainUserId);
    const result = await approveAcademy(plainContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });
});

describe("approveAcademy — validation", () => {
  it("rejects a malformed academy id", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await approveAcademy(ownerContext, "not-a-uuid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("returns not_found for a well-formed id that doesn't exist", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await approveAcademy(ownerContext, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });
});

describe("approveAcademy — success", () => {
  it("sets approved_by/approved_at when the actor is platform_owner", async () => {
    const academyId = await createAcademy(ownerUserId);
    createdAcademyIds.push(academyId);

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await approveAcademy(ownerContext, academyId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.academy.status).toBe("approved");
      expect(result.academy.approvedAt).not.toBeNull();
    }

    const [row] = await db
      .select({ approvedBy: academies.approvedBy, approvedAt: academies.approvedAt })
      .from(academies)
      .where(eq(academies.id, academyId));
    expect(row?.approvedBy).toBe(ownerUserId);
    expect(row?.approvedAt).not.toBeNull();

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, academyId));
    expect(audit?.action).toBe("approveAcademy");
    expect(audit?.entityType).toBe("academy");
    expect(audit?.actorUserId).toBe(ownerUserId);
  });

  it("refuses to approve an already-approved academy a second time", async () => {
    const academyId = await createAcademy(ownerUserId);
    createdAcademyIds.push(academyId);

    const ownerContext = await resolveAuthContext(ownerUserId);
    const first = await approveAcademy(ownerContext, academyId);
    expect(first.ok).toBe(true);

    const second = await approveAcademy(ownerContext, academyId);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("already_approved");
    }
  });
});

describe("listAcademies / getAcademyById", () => {
  it("derives pending_approval vs approved status correctly", async () => {
    const pendingId = await createAcademy(ownerUserId);
    createdAcademyIds.push(pendingId);
    const approvedId = await createAcademy(ownerUserId);
    createdAcademyIds.push(approvedId);

    const ownerContext = await resolveAuthContext(ownerUserId);
    const approveResult = await approveAcademy(ownerContext, approvedId);
    expect(approveResult.ok).toBe(true);

    const all = await listAcademies();
    const pending = all.find((a) => a.id === pendingId);
    const approved = all.find((a) => a.id === approvedId);
    expect(pending?.status).toBe("pending_approval");
    expect(approved?.status).toBe("approved");
    expect(approved?.approvedByEmail).not.toBeNull();

    const fetchedPending = await getAcademyById(pendingId);
    expect(fetchedPending?.status).toBe("pending_approval");
    expect(fetchedPending?.createdByEmail).not.toBeNull();

    const notFound = await getAcademyById(randomUUID());
    expect(notFound).toBeNull();

    const malformed = await getAcademyById("not-a-uuid");
    expect(malformed).toBeNull();
  });
});
