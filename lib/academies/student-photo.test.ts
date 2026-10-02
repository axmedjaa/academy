import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  branches,
  staffBranchAssignments,
  staffProfiles,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";

// Real Cloudflare R2 is never called from the test suite — same
// single-boundary mock as academy-logo.test.ts/books.test.ts, so these
// tests verify keys/authorization/audit/DB behavior without a real
// network call.
vi.mock("@/lib/storage/client", () => ({
  getUploadUrl: vi.fn(),
  getDownloadUrl: vi.fn(),
  deleteObject: vi.fn(),
  headObject: vi.fn(),
}));

import { deleteObject, getDownloadUrl, getUploadUrl, headObject } from "@/lib/storage/client";
import { getStudentPhotoKey } from "@/lib/storage/keys";
import {
  MAX_STUDENT_PHOTO_SIZE_BYTES,
  confirmStudentPhotoUpload,
  getStudentPhotoUrl,
  removeStudentPhoto,
  requestNewStudentPhotoUploadUrl,
  requestStudentPhotoUploadUrl,
} from "./students";
import { registerStudent } from "./register-student";

const getUploadUrlMock = vi.mocked(getUploadUrl);
const getDownloadUrlMock = vi.mocked(getDownloadUrl);
const headObjectMock = vi.mocked(headObject);
const deleteObjectMock = vi.mocked(deleteObject);

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `student-photo-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Student Photo Test Plan ${randomUUID()}`,
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
      name: `Student Photo Test Academy ${randomUUID()}`,
      slug: `student-photo-test-${randomUUID()}`,
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

async function setupAcademy(role: AcademyRole): Promise<{ academyId: string; userId: string; context: AuthContext }> {
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

async function insertBranchDirect(academyId: string): Promise<string> {
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${randomUUID().slice(0, 8)}`, code: `BR-${randomUUID().slice(0, 8)}` })
    .returning({ id: branches.id });
  return row.id;
}

async function insertStudentDirect(
  academyId: string,
  branchId: string,
  creatorUserId: string,
  overrides: Partial<typeof students.$inferInsert> = {},
): Promise<typeof students.$inferSelect> {
  const [row] = await db
    .insert(students)
    .values({
      academyId,
      branchId,
      studentNumber: `STD-${randomUUID().slice(0, 8).toUpperCase()}`,
      fullName: `Test Student ${randomUUID().slice(0, 8)}`,
      phone: "+1-555-0177",
      createdBy: creatorUserId,
      ...overrides,
    })
    .returning();
  return row;
}

async function assignUserToBranches(academyId: string, userId: string, branchIds: string[]): Promise<void> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Test Staff Member", phone: "+1-555-0100" })
    .returning({ id: staffProfiles.id });
  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({ academyId, staffProfileId: profile.id, branchId });
  }
}

beforeEach(() => {
  getUploadUrlMock.mockReset();
  getDownloadUrlMock.mockReset();
  headObjectMock.mockReset();
  deleteObjectMock.mockReset();
  getUploadUrlMock.mockResolvedValue({ ok: true, uploadUrl: "https://r2.example/signed-put", expiresInSeconds: 300 });
  deleteObjectMock.mockResolvedValue({ ok: true });
});

afterAll(async () => {
  for (const academyId of createdAcademyIds) {
    await db.delete(auditLogs).where(eq(auditLogs.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    await db.delete(staffBranchAssignments).where(eq(staffBranchAssignments.academyId, academyId));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("requestStudentPhotoUploadUrl — authorization and scope", () => {
  it("refuses a role with no write access to students (finance_officer)", async () => {
    const { academyId, context } = await setupAcademy("finance_officer");
    const branchId = await insertBranchDirect(academyId);
    const creator = await createUser();
    const student = await insertStudentDirect(academyId, branchId, creator);

    const result = await requestStudentPhotoUploadUrl(context, student.id, {
      contentType: "image/png",
      fileSizeBytes: 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(getUploadUrlMock).not.toHaveBeenCalled();
  });

  it("refuses a branch-limited caller (admissions_officer) for a student outside their assigned branch, with a generic not_found", async () => {
    const { academyId, userId, context } = await setupAcademy("admissions_officer");
    const assignedBranch = await insertBranchDirect(academyId);
    const otherBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const creator = await createUser();
    const student = await insertStudentDirect(academyId, otherBranch, creator);

    const result = await requestStudentPhotoUploadUrl(context, student.id, {
      contentType: "image/png",
      fileSizeBytes: 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("allows an academy-wide manager and returns an academy-scoped key", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const creator = await createUser();
    const student = await insertStudentDirect(academyId, branchId, creator);

    const result = await requestStudentPhotoUploadUrl(context, student.id, {
      contentType: "image/png",
      fileSizeBytes: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.key.startsWith(`academies/${academyId}/student-photos/`)).toBe(true);
  });

  it("rejects a disallowed content type without ever calling getUploadUrl", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const creator = await createUser();
    const student = await insertStudentDirect(academyId, branchId, creator);

    const result = await requestStudentPhotoUploadUrl(context, student.id, {
      contentType: "application/pdf",
      fileSizeBytes: 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(getUploadUrlMock).not.toHaveBeenCalled();
  });

  it("rejects a file over MAX_STUDENT_PHOTO_SIZE_BYTES", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const creator = await createUser();
    const student = await insertStudentDirect(academyId, branchId, creator);

    const result = await requestStudentPhotoUploadUrl(context, student.id, {
      contentType: "image/png",
      fileSizeBytes: MAX_STUDENT_PHOTO_SIZE_BYTES + 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("requestNewStudentPhotoUploadUrl — authorization (no student yet)", () => {
  it("refuses a role with no write access (trainer)", async () => {
    const { context } = await setupAcademy("trainer");

    const result = await requestNewStudentPhotoUploadUrl(context, { contentType: "image/png", fileSizeBytes: 1000 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(getUploadUrlMock).not.toHaveBeenCalled();
  });

  it("allows admissions_officer and returns an academy-scoped (not student-scoped) key", async () => {
    const { academyId, context } = await setupAcademy("admissions_officer");

    const result = await requestNewStudentPhotoUploadUrl(context, { contentType: "image/webp", fileSizeBytes: 1000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.key.startsWith(`academies/${academyId}/student-photos/`)).toBe(true);
  });
});

describe("verifyStudentPhotoUpload / confirmStudentPhotoUpload", () => {
  it("rejects a key belonging to a different academy, without ever calling headObject", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const creator = await createUser();
    const student = await insertStudentDirect(academyId, branchId, creator);
    const foreignKey = getStudentPhotoKey({ academyId: randomUUID(), extension: "png" });

    const result = await confirmStudentPhotoUpload(context, student.id, { key: foreignKey });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  it("rejects when the object does not exist in R2", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const creator = await createUser();
    const student = await insertStudentDirect(academyId, branchId, creator);
    const key = getStudentPhotoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: false });

    const result = await confirmStudentPhotoUpload(context, student.id, { key });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("deletes the object and rejects a real content-type the allowlist refuses", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const creator = await createUser();
    const student = await insertStudentDirect(academyId, branchId, creator);
    const key = getStudentPhotoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "application/pdf", contentLength: 1000 } });

    const result = await confirmStudentPhotoUpload(context, student.id, { key });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(deleteObjectMock).toHaveBeenCalledWith(key);
  });

  it("deletes the object and rejects a real size over the limit", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const creator = await createUser();
    const student = await insertStudentDirect(academyId, branchId, creator);
    const key = getStudentPhotoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({
      ok: true,
      exists: true,
      info: { contentType: "image/png", contentLength: MAX_STUDENT_PHOTO_SIZE_BYTES + 1 },
    });

    const result = await confirmStudentPhotoUpload(context, student.id, { key });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(deleteObjectMock).toHaveBeenCalledWith(key);
  });

  it("persists the key on students.profileImageRef, writes an audit row, and never deletes the first photo", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId);
    const key = getStudentPhotoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });

    const result = await confirmStudentPhotoUpload(context, student.id, { key });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profileImageRef).toBe(key);
    expect(deleteObjectMock).not.toHaveBeenCalled();

    const [row] = await db.select().from(students).where(eq(students.id, student.id));
    expect(row.profileImageRef).toBe(key);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, student.id));
    expect(audit?.action).toBe("uploadStudentPhoto");
  });

  it("replacing an existing photo deletes the OLD object, not the new one", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const oldKey = getStudentPhotoKey({ academyId, extension: "png" });
    const student = await insertStudentDirect(academyId, branchId, userId, { profileImageRef: oldKey });
    const newKey = getStudentPhotoKey({ academyId, extension: "webp" });
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/webp", contentLength: 2000 } });

    const result = await confirmStudentPhotoUpload(context, student.id, { key: newKey });

    expect(result.ok).toBe(true);
    expect(deleteObjectMock).toHaveBeenCalledWith(oldKey);
    expect(deleteObjectMock).not.toHaveBeenCalledWith(newKey);

    const [row] = await db.select().from(students).where(eq(students.id, student.id));
    expect(row.profileImageRef).toBe(newKey);
  });

  it("refuses to confirm a photo for a student outside a branch-limited caller's assigned branch", async () => {
    const { academyId, userId, context } = await setupAcademy("admissions_officer");
    const assignedBranch = await insertBranchDirect(academyId);
    const otherBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const creator = await createUser();
    const student = await insertStudentDirect(academyId, otherBranch, creator);
    const key = getStudentPhotoKey({ academyId, extension: "png" });

    const result = await confirmStudentPhotoUpload(context, student.id, { key });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
    expect(headObjectMock).not.toHaveBeenCalled();
  });
});

describe("removeStudentPhoto", () => {
  it("is a no-op (still ok:true) when the student has no photo", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId);

    const result = await removeStudentPhoto(context, student.id);

    expect(result.ok).toBe(true);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("deletes the R2 object and clears the database reference, with an audit row", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const key = getStudentPhotoKey({ academyId, extension: "png" });
    const student = await insertStudentDirect(academyId, branchId, userId, { profileImageRef: key });

    const result = await removeStudentPhoto(context, student.id);

    expect(result.ok).toBe(true);
    expect(deleteObjectMock).toHaveBeenCalledWith(key);

    const [row] = await db.select().from(students).where(eq(students.id, student.id));
    expect(row.profileImageRef).toBeNull();

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, student.id));
    expect(audit?.action).toBe("removeStudentPhoto");
  });

  it("still clears the database reference even when the R2 delete fails", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const key = getStudentPhotoKey({ academyId, extension: "png" });
    const student = await insertStudentDirect(academyId, branchId, userId, { profileImageRef: key });
    deleteObjectMock.mockResolvedValue({ ok: false, error: "boom" });

    const result = await removeStudentPhoto(context, student.id);

    expect(result.ok).toBe(true);
    const [row] = await db.select().from(students).where(eq(students.id, student.id));
    expect(row.profileImageRef).toBeNull();
  });
});

describe("getStudentPhotoUrl", () => {
  it("returns null without calling getDownloadUrl when there is no ref", async () => {
    const result = await getStudentPhotoUrl(null);
    expect(result).toBeNull();
    expect(getDownloadUrlMock).not.toHaveBeenCalled();
  });

  it("delegates to getDownloadUrl and returns its signed url", async () => {
    getDownloadUrlMock.mockResolvedValue({ ok: true, downloadUrl: "https://r2.example/signed-get" });
    const result = await getStudentPhotoUrl("academies/abc/student-photos/x.png");
    expect(result).toBe("https://r2.example/signed-get");
  });

  it("returns null (never throws) when R2 is unreachable", async () => {
    getDownloadUrlMock.mockResolvedValue({ ok: false, error: "boom" });
    const result = await getStudentPhotoUrl("academies/abc/student-photos/x.png");
    expect(result).toBeNull();
  });
});

describe("registerStudent with a profileImageRef", () => {
  it("verifies and persists a provided photo key on the new student row", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const key = getStudentPhotoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });

    const result = await registerStudent(context, { branchId, fullName: "New Student", profileImageRef: key });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.student.profileImageRef).toBe(key);
    expect(headObjectMock).toHaveBeenCalledTimes(1);
  });

  it("fails registration entirely (no student row created) when the provided key fails verification", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const key = getStudentPhotoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: false });

    const result = await registerStudent(context, { branchId, fullName: "Unverified Photo Student", profileImageRef: key });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const rows = await db.select().from(students).where(eq(students.academyId, academyId));
    expect(rows).toHaveLength(0);
  });

  it("registers successfully with no photo at all (the field is optional)", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);

    const result = await registerStudent(context, { branchId, fullName: "No Photo Student" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.student.profileImageRef).toBeNull();
    expect(headObjectMock).not.toHaveBeenCalled();
  });
});
