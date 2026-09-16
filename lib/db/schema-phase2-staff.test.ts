// Phase 2, Item 33 — schema-only test for staff_profiles/
// staff_branch_assignments/staff_documents. This item adds no business
// logic (no server actions), so per this codebase's convention of testing
// DB constraints directly (see lib/subscriptions/state-machine.test.ts's
// "rejects ends_at before starts_at (DB check constraint)" tests), this
// file inserts valid rows into each new table and confirms the FK/unique
// constraints reject invalid ones, straight against the database.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  branches,
  staffBranchAssignments,
  staffDocuments,
  staffProfiles,
  users,
} from "@/lib/db/schema";

let ownerUserId: string;
let academyId: string;
let branchAId: string;
let branchBId: string;

const createdUserIds: string[] = [];
const createdStaffProfileIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `staff-schema-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

// staff_profiles has a unique (academy_id, user_id) constraint, so every
// test that needs "a staff profile" gets its own fresh user rather than
// sharing one — matching the existing test suites' pattern of a fresh
// randomUUID()-suffixed fixture per case.
async function createStaffProfile(
  overrides: Partial<{ userId: string; status: "active" | "archived" }> = {},
): Promise<string> {
  const userId = overrides.userId ?? (await createUser());
  const [row] = await db
    .insert(staffProfiles)
    .values({
      academyId,
      userId,
      fullName: "Ada Lovelace",
      phone: "+1-555-0100",
      status: overrides.status,
    })
    .returning({ id: staffProfiles.id });
  createdStaffProfileIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  ownerUserId = await createUser();

  const [academy] = await db
    .insert(academies)
    .values({
      name: `Staff schema test academy ${randomUUID()}`,
      slug: `staff-schema-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  academyId = academy.id;

  const [branchA] = await db
    .insert(branches)
    .values({ academyId, name: "Branch A", code: "A" })
    .returning({ id: branches.id });
  branchAId = branchA.id;

  const [branchB] = await db
    .insert(branches)
    .values({ academyId, name: "Branch B", code: "B" })
    .returning({ id: branches.id });
  branchBId = branchB.id;
});

afterAll(async () => {
  // FK ordering: staff_documents/staff_branch_assignments reference
  // staff_profiles, which references academies/users; branches also
  // reference academies.
  await db.delete(staffDocuments).where(eq(staffDocuments.academyId, academyId));
  await db
    .delete(staffBranchAssignments)
    .where(eq(staffBranchAssignments.academyId, academyId));
  for (const id of createdStaffProfileIds) {
    await db.delete(staffProfiles).where(eq(staffProfiles.id, id));
  }
  await db.delete(branches).where(eq(branches.academyId, academyId));
  await db.delete(academies).where(eq(academies.id, academyId));
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("staff_profiles", () => {
  it("inserts a full valid row and defaults status to active", async () => {
    const userId = await createUser();
    const [row] = await db
      .insert(staffProfiles)
      .values({
        academyId,
        userId,
        employeeNumber: "EMP-001",
        fullName: "Ada Lovelace",
        phone: "+1-555-0100",
        email: "ada@example.com",
        hireDate: "2024-01-15",
      })
      .returning();
    createdStaffProfileIds.push(row.id);

    expect(row.status).toBe("active");
    expect(row.employeeNumber).toBe("EMP-001");
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("inserts a minimal row with nullable fields left null", async () => {
    const userId = await createUser();
    const [row] = await db
      .insert(staffProfiles)
      .values({
        academyId,
        userId,
        fullName: "Grace Hopper",
        phone: "+1-555-0101",
      })
      .returning();
    createdStaffProfileIds.push(row.id);

    expect(row.employeeNumber).toBeNull();
    expect(row.email).toBeNull();
    expect(row.hireDate).toBeNull();
    expect(row.status).toBe("active");
  });

  it("accepts 'archived' as a valid status (reused branch_status enum)", async () => {
    const staffId = await createStaffProfile({ status: "archived" });
    const [row] = await db
      .select({ status: staffProfiles.status })
      .from(staffProfiles)
      .where(eq(staffProfiles.id, staffId));

    expect(row.status).toBe("archived");
  });

  it("rejects a duplicate (academy_id, user_id) pair", async () => {
    const userId = await createUser();
    await createStaffProfile({ userId });

    await expect(
      db.insert(staffProfiles).values({
        academyId,
        userId,
        fullName: "Duplicate Person",
        phone: "+1-555-0199",
      }),
    ).rejects.toThrow();
  });

  it("rejects an academy_id that doesn't exist (FK violation)", async () => {
    const userId = await createUser();
    await expect(
      db.insert(staffProfiles).values({
        academyId: randomUUID(),
        userId,
        fullName: "No Academy",
        phone: "+1-555-0198",
      }),
    ).rejects.toThrow();
  });

  it("rejects a user_id that doesn't exist (FK violation)", async () => {
    await expect(
      db.insert(staffProfiles).values({
        academyId,
        userId: randomUUID(),
        fullName: "No User",
        phone: "+1-555-0197",
      }),
    ).rejects.toThrow();
  });
});

describe("staff_branch_assignments", () => {
  it("inserts a valid assignment", async () => {
    const staffId = await createStaffProfile();

    const [row] = await db
      .insert(staffBranchAssignments)
      .values({ academyId, staffProfileId: staffId, branchId: branchAId })
      .returning();

    expect(row.staffProfileId).toBe(staffId);
    expect(row.branchId).toBe(branchAId);
  });

  it("allows the same staff profile assigned to a second, different branch", async () => {
    const staffId = await createStaffProfile();

    await db
      .insert(staffBranchAssignments)
      .values({ academyId, staffProfileId: staffId, branchId: branchAId });
    const [row] = await db
      .insert(staffBranchAssignments)
      .values({ academyId, staffProfileId: staffId, branchId: branchBId })
      .returning();

    expect(row.branchId).toBe(branchBId);
  });

  it("rejects a duplicate (staff_profile_id, branch_id) pair", async () => {
    const staffId = await createStaffProfile();

    await db
      .insert(staffBranchAssignments)
      .values({ academyId, staffProfileId: staffId, branchId: branchAId });

    await expect(
      db
        .insert(staffBranchAssignments)
        .values({ academyId, staffProfileId: staffId, branchId: branchAId }),
    ).rejects.toThrow();
  });

  it("rejects a branch_id that doesn't exist (FK violation)", async () => {
    const staffId = await createStaffProfile();

    await expect(
      db.insert(staffBranchAssignments).values({
        academyId,
        staffProfileId: staffId,
        branchId: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it("rejects a staff_profile_id that doesn't exist (FK violation)", async () => {
    await expect(
      db.insert(staffBranchAssignments).values({
        academyId,
        staffProfileId: randomUUID(),
        branchId: branchAId,
      }),
    ).rejects.toThrow();
  });
});

describe("staff_documents", () => {
  it("inserts a valid row for each document_type value and defaults status to active", async () => {
    const staffId = await createStaffProfile();

    for (const documentType of ["id_copy", "certificate", "contract", "other"] as const) {
      const [row] = await db
        .insert(staffDocuments)
        .values({
          academyId,
          staffProfileId: staffId,
          documentType,
          fileRef: `file-ref-${documentType}`,
          uploadedBy: ownerUserId,
        })
        .returning();

      expect(row.documentType).toBe(documentType);
      expect(row.status).toBe("active");
    }
  });

  it("rejects a document_type outside the enum (DB-level guard, bypassing the TS type)", async () => {
    const staffId = await createStaffProfile();

    // Raw SQL bypasses Drizzle's TS-level enum narrowing to prove the
    // constraint is real at the database, not just enforced by the
    // TypeScript compiler.
    await expect(
      db.execute(
        sql`insert into staff_documents (academy_id, staff_profile_id, document_type, file_ref, uploaded_by)
            values (${academyId}, ${staffId}, 'not_a_real_type', 'ref', ${ownerUserId})`,
      ),
    ).rejects.toThrow();
  });

  it("rejects a staff_profile_id that doesn't exist (FK violation)", async () => {
    await expect(
      db.insert(staffDocuments).values({
        academyId,
        staffProfileId: randomUUID(),
        documentType: "id_copy",
        fileRef: "ref",
        uploadedBy: ownerUserId,
      }),
    ).rejects.toThrow();
  });

  it("rejects an uploaded_by that doesn't exist (FK violation)", async () => {
    const staffId = await createStaffProfile();

    await expect(
      db.insert(staffDocuments).values({
        academyId,
        staffProfileId: staffId,
        documentType: "id_copy",
        fileRef: "ref",
        uploadedBy: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});
