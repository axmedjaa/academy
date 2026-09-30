import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { academies, academyMemberships, users } from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import { resolveStaffLabels } from "./staff-labels";

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];

async function createUser(email?: string): Promise<{ id: string; email: string }> {
  const resolvedEmail = email ?? `staff-labels-test-${randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email: resolvedEmail, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id, email: users.email });
  createdUserIds.push(user.id);
  return user;
}

async function createAcademy(creatorUserId: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Staff Labels Test Academy ${randomUUID()}`,
      slug: `staff-labels-test-${randomUUID()}`,
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

afterAll(async () => {
  if (createdAcademyIds.length > 0) {
    await db.delete(academyMemberships).where(or(...createdAcademyIds.map((id) => eq(academyMemberships.academyId, id))));
    await db.delete(academies).where(or(...createdAcademyIds.map((id) => eq(academies.id, id))));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(or(...createdUserIds.map((id) => eq(users.id, id))));
  }
});

describe("resolveStaffLabels", () => {
  it("returns the friendly role label for a user with an active membership in this academy", async () => {
    const creator = await createUser();
    const academyId = await createAcademy(creator.id);
    const manager = await createUser();
    await addMembership(manager.id, academyId, "manager");

    const labels = await resolveStaffLabels(academyId, [manager.id]);
    expect(labels.get(manager.id)).toBe("Manager");
  });

  it("maps every academy role to its own distinct friendly label", async () => {
    const creator = await createUser();
    const academyId = await createAcademy(creator.id);
    const roles: AcademyRole[] = ["academy_owner", "academy_admin", "manager", "admissions_officer", "finance_officer", "trainer"];
    const userIds: string[] = [];
    for (const role of roles) {
      const user = await createUser();
      await addMembership(user.id, academyId, role);
      userIds.push(user.id);
    }

    const labels = await resolveStaffLabels(academyId, userIds);
    expect(labels.get(userIds[0])).toBe("Academy Owner");
    expect(labels.get(userIds[1])).toBe("Academy Administrator");
    expect(labels.get(userIds[2])).toBe("Manager");
    expect(labels.get(userIds[3])).toBe("Admissions Officer");
    expect(labels.get(userIds[4])).toBe("Finance Officer");
    expect(labels.get(userIds[5])).toBe("Trainer");
  });

  it("falls back to email when no membership row exists in this academy (e.g. removed staff)", async () => {
    const creator = await createUser();
    const academyId = await createAcademy(creator.id);
    const removedStaff = await createUser("removed-staff-fallback@example.com");
    // Deliberately no membership row inserted for removedStaff in this academy.

    const labels = await resolveStaffLabels(academyId, [removedStaff.id]);
    expect(labels.get(removedStaff.id)).toBe("removed-staff-fallback@example.com");
  });

  it("never leaks a role from a DIFFERENT academy — falls back to email if the membership is elsewhere", async () => {
    const creatorA = await createUser();
    const academyA = await createAcademy(creatorA.id);
    const creatorB = await createUser();
    const academyB = await createAcademy(creatorB.id);

    const user = await createUser();
    await addMembership(user.id, academyB, "manager");

    // Resolving against academyA (where this user has NO membership) must
    // fall back to email, not leak the "Manager" role from academyB.
    const labels = await resolveStaffLabels(academyA, [user.id]);
    expect(labels.get(user.id)).toBe(user.email);
  });

  it("returns an empty map for an empty id list without querying", async () => {
    const labels = await resolveStaffLabels(randomUUID(), []);
    expect(labels.size).toBe(0);
  });

  it("batches multiple ids into one lookup (no N+1) and dedupes repeated ids", async () => {
    const creator = await createUser();
    const academyId = await createAcademy(creator.id);
    const finance = await createUser();
    await addMembership(finance.id, academyId, "finance_officer");

    const labels = await resolveStaffLabels(academyId, [finance.id, finance.id, creator.id]);
    expect(labels.size).toBe(2);
    expect(labels.get(finance.id)).toBe("Finance Officer");
    // creator has no membership in this academy (only createdBy on the row) -> email fallback.
    expect(labels.get(creator.id)).toBe(creator.email);
  });
});
