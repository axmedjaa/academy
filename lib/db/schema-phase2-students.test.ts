// Phase 2, Item 37 — schema-only test for students/student_documents. This
// item adds no business logic (no server actions), so per this codebase's
// convention of testing DB constraints directly (see
// schema-phase2-staff.test.ts for the same pattern), this file inserts
// valid rows into each new table and confirms the FK/unique constraints
// reject invalid ones, straight against the database.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  branches,
  students,
  studentDocuments,
  users,
} from "@/lib/db/schema";

let ownerUserId: string;
let academyOneId: string;
let academyTwoId: string;
let branchId: string;

const createdUserIds: string[] = [];
const createdStudentIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `students-schema-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createStudent(
  overrides: Partial<{
    academyId: string;
    studentNumber: string;
    status: "active" | "archived";
  }> = {},
): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({
      academyId: overrides.academyId ?? academyOneId,
      branchId,
      studentNumber: overrides.studentNumber ?? `STD-${randomUUID().slice(0, 8)}`,
      fullName: "Jane Student",
      createdBy: ownerUserId,
      status: overrides.status,
    })
    .returning({ id: students.id });
  createdStudentIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  ownerUserId = await createUser();

  const [academyOne] = await db
    .insert(academies)
    .values({
      name: `Students schema test academy 1 ${randomUUID()}`,
      slug: `students-schema-test-1-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  academyOneId = academyOne.id;

  const [academyTwo] = await db
    .insert(academies)
    .values({
      name: `Students schema test academy 2 ${randomUUID()}`,
      slug: `students-schema-test-2-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  academyTwoId = academyTwo.id;

  const [branch] = await db
    .insert(branches)
    .values({ academyId: academyOneId, name: "Main Branch", code: "MAIN" })
    .returning({ id: branches.id });
  branchId = branch.id;
});

afterAll(async () => {
  // FK ordering: student_documents references students, which references
  // academies/branches/users.
  await db
    .delete(studentDocuments)
    .where(eq(studentDocuments.academyId, academyOneId));
  for (const id of createdStudentIds) {
    await db.delete(students).where(eq(students.id, id));
  }
  await db.delete(branches).where(eq(branches.academyId, academyOneId));
  await db.delete(academies).where(eq(academies.id, academyOneId));
  await db.delete(academies).where(eq(academies.id, academyTwoId));
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("students", () => {
  it("inserts a full valid row and defaults status to active", async () => {
    const [row] = await db
      .insert(students)
      .values({
        academyId: academyOneId,
        branchId,
        studentNumber: `STD-${randomUUID().slice(0, 8)}`,
        fullName: "Ada Lovelace",
        dateOfBirth: "2005-06-15",
        gender: "female",
        phone: "+1-555-0100",
        email: "ada@example.com",
        guardianName: "Lord Byron",
        guardianPhone: "+1-555-0101",
        createdBy: ownerUserId,
      })
      .returning();
    createdStudentIds.push(row.id);

    expect(row.status).toBe("active");
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("inserts a minimal row with nullable fields left null", async () => {
    const [row] = await db
      .insert(students)
      .values({
        academyId: academyOneId,
        branchId,
        studentNumber: `STD-${randomUUID().slice(0, 8)}`,
        fullName: "Grace Hopper",
        createdBy: ownerUserId,
      })
      .returning();
    createdStudentIds.push(row.id);

    expect(row.dateOfBirth).toBeNull();
    expect(row.gender).toBeNull();
    expect(row.guardianName).toBeNull();
    expect(row.status).toBe("active");
  });

  it("accepts 'archived' as a valid status (reused branch_status enum)", async () => {
    const studentId = await createStudent({ status: "archived" });
    const [row] = await db
      .select({ status: students.status })
      .from(students)
      .where(eq(students.id, studentId));

    expect(row.status).toBe("archived");
  });

  it("rejects a duplicate (academy_id, student_number) pair within the same academy", async () => {
    const studentNumber = `STD-${randomUUID().slice(0, 8)}`;
    await createStudent({ studentNumber });

    await expect(
      db.insert(students).values({
        academyId: academyOneId,
        branchId,
        studentNumber,
        fullName: "Duplicate Student",
        createdBy: ownerUserId,
      }),
    ).rejects.toThrow();
  });

  it("allows the same student_number to be reused across two different academies", async () => {
    const studentNumber = `STD-${randomUUID().slice(0, 8)}`;
    await createStudent({ academyId: academyOneId, studentNumber });

    // academyTwo has no branches of its own in this test; insert directly
    // against academyOneId's branch is invalid across tenants, so create a
    // second branch under academyTwo for this one case.
    const [branchTwo] = await db
      .insert(branches)
      .values({ academyId: academyTwoId, name: "Other Academy Branch", code: "MAIN" })
      .returning({ id: branches.id });

    const [row] = await db
      .insert(students)
      .values({
        academyId: academyTwoId,
        branchId: branchTwo.id,
        studentNumber,
        fullName: "Same Number Different Academy",
        createdBy: ownerUserId,
      })
      .returning();
    createdStudentIds.push(row.id);

    expect(row.studentNumber).toBe(studentNumber);

    await db.delete(students).where(eq(students.id, row.id));
    await db.delete(branches).where(eq(branches.id, branchTwo.id));
  });

  it("rejects an academy_id that doesn't exist (FK violation)", async () => {
    await expect(
      db.insert(students).values({
        academyId: randomUUID(),
        branchId,
        studentNumber: `STD-${randomUUID().slice(0, 8)}`,
        fullName: "No Academy",
        createdBy: ownerUserId,
      }),
    ).rejects.toThrow();
  });

  it("rejects a branch_id that doesn't exist (FK violation)", async () => {
    await expect(
      db.insert(students).values({
        academyId: academyOneId,
        branchId: randomUUID(),
        studentNumber: `STD-${randomUUID().slice(0, 8)}`,
        fullName: "No Branch",
        createdBy: ownerUserId,
      }),
    ).rejects.toThrow();
  });

  it("rejects a created_by that doesn't exist (FK violation)", async () => {
    await expect(
      db.insert(students).values({
        academyId: academyOneId,
        branchId,
        studentNumber: `STD-${randomUUID().slice(0, 8)}`,
        fullName: "No Creator",
        createdBy: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});

describe("student_documents", () => {
  it("inserts a valid row for each document_type value and defaults status to active", async () => {
    const studentId = await createStudent();

    for (const documentType of ["id_copy", "certificate", "other"] as const) {
      const [row] = await db
        .insert(studentDocuments)
        .values({
          academyId: academyOneId,
          studentId,
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
    const studentId = await createStudent();

    // "contract" is a valid staff_document_type value but must be rejected
    // here — student_documents has its own, smaller enum with no
    // "contract" option, proving the two enums are genuinely separate at
    // the database level, not just distinguished by TypeScript.
    await expect(
      db.execute(
        sql`insert into student_documents (academy_id, student_id, document_type, file_ref, uploaded_by)
            values (${academyOneId}, ${studentId}, 'contract', 'ref', ${ownerUserId})`,
      ),
    ).rejects.toThrow();
  });

  it("rejects a student_id that doesn't exist (FK violation)", async () => {
    await expect(
      db.insert(studentDocuments).values({
        academyId: academyOneId,
        studentId: randomUUID(),
        documentType: "id_copy",
        fileRef: "ref",
        uploadedBy: ownerUserId,
      }),
    ).rejects.toThrow();
  });

  it("rejects an uploaded_by that doesn't exist (FK violation)", async () => {
    const studentId = await createStudent();

    await expect(
      db.insert(studentDocuments).values({
        academyId: academyOneId,
        studentId,
        documentType: "id_copy",
        fileRef: "ref",
        uploadedBy: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});
