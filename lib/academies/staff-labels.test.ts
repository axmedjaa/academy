import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { academies, academyMemberships, staffProfiles, users } from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import { nameFromEmail, resolveStaffLabels, resolveStaffNames } from "./staff-labels";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";

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
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active", academyWide: legacyAllBranchAccess(role) });
}

async function addProfile(userId: string, academyId: string, fullName: string): Promise<void> {
  await db.insert(staffProfiles).values({ userId, academyId, fullName, phone: "+252610000000" });
}

afterAll(async () => {
  if (createdAcademyIds.length > 0) {
    await db.delete(staffProfiles).where(or(...createdAcademyIds.map((id) => eq(staffProfiles.academyId, id))));
    await db.delete(academyMemberships).where(or(...createdAcademyIds.map((id) => eq(academyMemberships.academyId, id))));
    await db.delete(academies).where(or(...createdAcademyIds.map((id) => eq(academies.id, id))));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(or(...createdUserIds.map((id) => eq(users.id, id))));
  }
});

describe("nameFromEmail", () => {
  it("turns the part before @ into a capitalised name", () => {
    expect(nameFromEmail("amina.yusuf@example.com")).toBe("Amina Yusuf");
    expect(nameFromEmail("abdi_noor-ali@example.com")).toBe("Abdi Noor Ali");
  });

  it("never returns an empty name", () => {
    expect(nameFromEmail("._-@example.com")).toBe("._-@example.com");
  });
});

describe("resolveStaffLabels", () => {
  it("returns the staff-profile name, not the role", async () => {
    const creator = await createUser();
    const academyId = await createAcademy(creator.id);
    const manager = await createUser();
    await addMembership(manager.id, academyId, "manager");
    await addProfile(manager.id, academyId, "Amina Yusuf");

    const labels = await resolveStaffLabels(academyId, [manager.id]);
    expect(labels.get(manager.id)).toBe("Amina Yusuf");
  });

  it("never returns a role label, for any role", async () => {
    const creator = await createUser();
    const academyId = await createAcademy(creator.id);
    const roles: AcademyRole[] = ["academy_owner", "academy_admin", "manager", "trainer"];
    const members: { id: string; email: string }[] = [];
    for (const role of roles) {
      const user = await createUser();
      await addMembership(user.id, academyId, role);
      members.push(user);
    }

    const labels = await resolveStaffLabels(academyId, members.map((u) => u.id));
    for (const user of members) {
      expect(labels.get(user.id)).toBe(nameFromEmail(user.email));
    }
    for (const roleLabel of ["Academy Owner", "Academy Administrator", "Manager", "Trainer"]) {
      expect([...labels.values()]).not.toContain(roleLabel);
    }
  });

  it("names an owner with no staff profile from their email", async () => {
    const owner = await createUser("hodan.farah@example.com".replace("@", `+${randomUUID().slice(0, 6)}@`));
    const academyId = await createAcademy(owner.id);
    await addMembership(owner.id, academyId, "academy_owner");

    const labels = await resolveStaffLabels(academyId, [owner.id]);
    expect(labels.get(owner.id)).toMatch(/^Hodan Farah\+/);
  });

  it("still names removed staff (no membership) from their kept profile", async () => {
    const creator = await createUser();
    const academyId = await createAcademy(creator.id);
    const removed = await createUser();
    await addProfile(removed.id, academyId, "Former Teacher");

    const labels = await resolveStaffLabels(academyId, [removed.id]);
    expect(labels.get(removed.id)).toBe("Former Teacher");
  });

  it("never uses a staff-profile name from a DIFFERENT academy", async () => {
    const creatorA = await createUser();
    const academyA = await createAcademy(creatorA.id);
    const creatorB = await createUser();
    const academyB = await createAcademy(creatorB.id);

    const user = await createUser();
    await addMembership(user.id, academyB, "manager");
    await addProfile(user.id, academyB, "Name Only In B");

    const labels = await resolveStaffLabels(academyA, [user.id]);
    expect(labels.get(user.id)).toBe(nameFromEmail(user.email));
  });

  it("returns 'Staff member' for an id with no account", async () => {
    const creator = await createUser();
    const academyId = await createAcademy(creator.id);
    const ghost = randomUUID();
    const labels = await resolveStaffLabels(academyId, [ghost]);
    expect(labels.get(ghost)).toBe("Staff member");
  });

  it("returns an empty map for an empty id list without querying", async () => {
    const labels = await resolveStaffLabels(randomUUID(), []);
    expect(labels.size).toBe(0);
  });

  it("batches multiple ids into one lookup (no N+1) and dedupes repeated ids", async () => {
    const creator = await createUser();
    const academyId = await createAcademy(creator.id);
    const manager = await createUser();
    await addMembership(manager.id, academyId, "manager");
    await addProfile(manager.id, academyId, "Amina Yusuf");

    const labels = await resolveStaffLabels(academyId, [manager.id, manager.id, creator.id]);
    expect(labels.size).toBe(2);
    expect(labels.get(manager.id)).toBe("Amina Yusuf");
    expect(labels.get(creator.id)).toBe(nameFromEmail(creator.email));
  });
});

describe("resolveStaffNames", () => {
  it("returns the same names as a plain object", async () => {
    const creator = await createUser();
    const academyId = await createAcademy(creator.id);
    const trainer = await createUser();
    await addMembership(trainer.id, academyId, "trainer");
    await addProfile(trainer.id, academyId, "Ahmed Ali");

    const names = await resolveStaffNames(academyId, [trainer.id, creator.id]);
    expect(names).toEqual({ [trainer.id]: "Ahmed Ali", [creator.id]: nameFromEmail(creator.email) });
  });
});
