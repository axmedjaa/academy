import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  batchCourses,
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batches,
  branches,
  courses,
  programs,
  staffProfiles,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { getCourseImageKey } from "@/lib/storage/keys";

// Real Cloudflare R2 is never called from the test suite — same
// single-boundary mock as academy-logo.test.ts/books.test.ts. None of this
// file's existing tests exercise a real upload key (they only pass legacy
// externally-hosted-URL `imageRef` strings, which `getCourseImageUrl`/
// `isCourseImageKey` deliberately skip R2 entirely for), so mocking this
// module is safe to add without touching any pre-existing test's behavior.
vi.mock("@/lib/storage/client", () => ({
  getUploadUrl: vi.fn(),
  getDownloadUrl: vi.fn(),
  deleteObject: vi.fn(),
  headObject: vi.fn(),
  getObjectPrefix: vi.fn(),
}));

import { deleteObject, getObjectPrefix, getUploadUrl, headObject } from "@/lib/storage/client";
import { VALID_SIGNATURE_BYTES, INVALID_SIGNATURE_BYTES } from "@/lib/storage/test-signature-fixtures";
import {
  archiveCourse,
  createCourse,
  deleteCourse,
  getCourse,
  getCourseDeletionEligibility,
  listCourseEnrollments,
  listCourses,
  requestCourseImageUploadUrl,
  updateCourse,
  type CreateCourseInput,
} from "./courses";

const getUploadUrlMock = vi.mocked(getUploadUrl);
const headObjectMock = vi.mocked(headObject);
const deleteObjectMock = vi.mocked(deleteObject);
const getObjectPrefixMock = vi.mocked(getObjectPrefix);

beforeEach(() => {
  getUploadUrlMock.mockReset();
  headObjectMock.mockReset();
  deleteObjectMock.mockReset();
  getObjectPrefixMock.mockReset();
  getUploadUrlMock.mockResolvedValue({ ok: true, uploadUrl: "https://r2.example/signed-put", expiresInSeconds: 300 });
  deleteObjectMock.mockResolvedValue({ ok: true });
  headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });
  getObjectPrefixMock.mockResolvedValue({ ok: true, exists: true, bytes: VALID_SIGNATURE_BYTES["image/png"] });
});

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `courses-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(maxCourses = 5): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Courses Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses,
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
      name: `Courses Test Academy ${randomUUID()}`,
      slug: `courses-test-${randomUUID()}`,
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

async function insertProgramDirect(academyId: string): Promise<string> {
  const [row] = await db
    .insert(programs)
    .values({ academyId, name: `Program ${randomUUID()}` })
    .returning({ id: programs.id });
  return row.id;
}

async function setupAcademy(
  role: AcademyRole,
  maxCourses = 5,
): Promise<{ academyId: string; userId: string; programId: string; context: AuthContext }> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan(maxCourses);
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    endsAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: creatorUserId,
  });

  const userId = await createUser();
  await addMembership(userId, academyId, role);
  const programId = await insertProgramDirect(academyId);

  return { academyId, userId, programId, context: { userId, branchIds: [], academyWide: false } };
}

function validInput(programId: string, overrides: Partial<CreateCourseInput> = {}): CreateCourseInput {
  return {
    programId,
    name: `Test Course ${randomUUID()}`,
    code: `C-${randomUUID().slice(0, 6)}`,
    description: "A test course",
    durationWeeks: 8,
    ...overrides,
  };
}

async function insertBranchDirect(academyId: string): Promise<string> {
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` })
    .returning({ id: branches.id });
  return row.id;
}

async function insertBatchDirect(academyId: string, branchId: string, courseId: string): Promise<string> {
  const [row] = await db
    .insert(batches)
    .values({
      academyId,
      branchId,
      courseId,
      name: `Batch ${randomUUID()}`,
      code: `B-${randomUUID().slice(0, 8)}`,
      startDate: "2026-01-01",
    })
    .returning({ id: batches.id });
  return row.id;
}

afterAll(async () => {
  await db
    .delete(auditLogs)
    .where(
      or(
        ...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)),
        ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id)),
      ),
    );
  for (const academyId of createdAcademyIds) {
    await db.delete(batchCourses).where(eq(batchCourses.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
  }
  for (const academyId of createdAcademyIds) {
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
}, 180_000);

describe("createCourse — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: create allowed = %s", async (role, allowed) => {
    const { context, programId } = await setupAcademy(role);
    const result = await createCourse(context, validInput(programId));
    expect(result.ok).toBe(allowed);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("writes an audit row on successful creation", async () => {
    const { academyId, userId, programId, context } = await setupAcademy("academy_owner");
    const result = await createCourse(context, validInput(programId, { name: "Audited Course" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, result.course.id));
    expect(audit?.action).toBe("createCourse");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("rejects a nonexistent programId with code 'not_found'", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await createCourse(context, validInput(randomUUID()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a cross-academy programId with code 'not_found' (never 'forbidden')", async () => {
    const other = await setupAcademy("academy_owner");
    const { context } = await setupAcademy("academy_owner");
    const result = await createCourse(context, validInput(other.programId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a duplicate course name within the same academy with code 'conflict'", async () => {
    const { context, programId } = await setupAcademy("academy_owner");
    const first = await createCourse(context, validInput(programId, { name: "Same Course Name" }));
    expect(first.ok).toBe(true);

    const second = await createCourse(context, validInput(programId, { name: "Same Course Name" }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });
});

describe("checkAllowance('courses') — hard block at plan limit", () => {
  it("allows creation up to the plan limit and hard-blocks the next one", async () => {
    const { context, programId } = await setupAcademy("academy_owner", 1);

    const first = await createCourse(context, validInput(programId));
    expect(first.ok).toBe(true);

    const second = await createCourse(context, validInput(programId));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("allowance");
      expect(second.error.message).toMatch(/limit/i);
    }
  });

  it("archiving a course frees the allowance slot for a new one", async () => {
    const { context, programId } = await setupAcademy("academy_owner", 1);

    const first = await createCourse(context, validInput(programId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const blocked = await createCourse(context, validInput(programId));
    expect(blocked.ok).toBe(false);

    const archived = await archiveCourse(context, first.course.id);
    expect(archived.ok).toBe(true);
    if (archived.ok) expect(archived.course.status).toBe("archived");

    const afterArchive = await createCourse(context, validInput(programId));
    expect(afterArchive.ok).toBe(true);
  });
});

describe("archiveCourse / updateCourse — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: update/archive allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const created = await createCourse(owner.context, validInput(owner.programId));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const updateResult = await updateCourse(
      actingContext,
      created.course.id,
      validInput(owner.programId, { name: "Renamed Course" }),
    );
    expect(updateResult.ok).toBe(allowed);
    if (!updateResult.ok) expect(updateResult.error.code).toBe("forbidden");

    const archiveResult = await archiveCourse(actingContext, created.course.id);
    expect(archiveResult.ok).toBe(allowed);
    if (!archiveResult.ok) expect(archiveResult.error.code).toBe("forbidden");
  });
});

describe("listCourses — tenant isolation", () => {
  it("never returns another academy's courses", async () => {
    const other = await setupAcademy("academy_owner");
    await createCourse(other.context, validInput(other.programId));

    const { context } = await setupAcademy("academy_owner");
    const result = await listCourses(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.courses).toEqual([]);
  });
});

// Simple course/enrollment model — start/end dates, image, and instructor.
describe("createCourse / updateCourse — dates, image, and instructor", () => {
  async function insertInstructor(academyId: string, userId: string, fullName: string): Promise<string> {
    const [row] = await db
      .insert(staffProfiles)
      .values({ academyId, userId, fullName, phone: "+1-555-0100" })
      .returning({ id: staffProfiles.id });
    return row.id;
  }

  it("saves start date, end date, image URL, and instructor on create", async () => {
    const { context, programId, academyId, userId } = await setupAcademy("academy_owner");
    const instructorId = await insertInstructor(academyId, userId, "Ahmed");

    const result = await createCourse(
      context,
      validInput(programId, {
        startDate: "2026-10-01",
        endDate: "2026-12-30",
        imageRef: "https://example.com/web-development.jpg",
        instructorId,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.course.startDate).toBe("2026-10-01");
    expect(result.course.endDate).toBe("2026-12-30");
    expect(result.course.imageRef).toBe("https://example.com/web-development.jpg");
    expect(result.course.instructorId).toBe(instructorId);
  });

  it("rejects an end date before the start date", async () => {
    const { context, programId } = await setupAcademy("academy_owner");
    const result = await createCourse(
      context,
      validInput(programId, { startDate: "2026-12-30", endDate: "2026-10-01" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects an instructor from a different academy with code 'not_found'", async () => {
    const other = await setupAcademy("academy_owner");
    const otherInstructorId = await insertInstructor(other.academyId, other.userId, "Outsider");

    const { context, programId } = await setupAcademy("academy_owner");
    const result = await createCourse(context, validInput(programId, { instructorId: otherInstructorId }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("creates a course with no dates/image/instructor (all optional)", async () => {
    const { context, programId } = await setupAcademy("academy_owner");
    const result = await createCourse(context, validInput(programId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.course.startDate).toBeNull();
    expect(result.course.endDate).toBeNull();
    expect(result.course.imageRef).toBeNull();
    expect(result.course.instructorId).toBeNull();
  });

  it("listCourses/getCourse resolve the instructor's display name", async () => {
    const { context, programId, academyId, userId } = await setupAcademy("academy_owner");
    const instructorId = await insertInstructor(academyId, userId, "Ahmed Instructor");
    const created = await createCourse(context, validInput(programId, { instructorId }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const listed = await listCourses(context);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const found = listed.courses.find((c) => c.id === created.course.id);
      expect(found?.instructorName).toBe("Ahmed Instructor");
    }

    const fetched = await getCourse(context, created.course.id);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) expect(fetched.course.instructorName).toBe("Ahmed Instructor");
  });

  it("updateCourse can clear a previously-set instructor/dates/image", async () => {
    const { context, programId, academyId, userId } = await setupAcademy("academy_owner");
    const instructorId = await insertInstructor(academyId, userId, "Ahmed");
    const created = await createCourse(
      context,
      validInput(programId, { instructorId, startDate: "2026-10-01", endDate: "2026-12-30", imageRef: "https://example.com/a.jpg" }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await updateCourse(context, created.course.id, validInput(programId));
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.course.instructorId).toBeNull();
      expect(updated.course.startDate).toBeNull();
      expect(updated.course.endDate).toBeNull();
      expect(updated.course.imageRef).toBeNull();
    }
  });
});

describe("requestCourseImageUploadUrl — authorization and format validation", () => {
  it("refuses a trainer (not allowed to manage courses)", async () => {
    const { context } = await setupAcademy("trainer");
    const result = await requestCourseImageUploadUrl(context, { contentType: "image/png", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(getUploadUrlMock).not.toHaveBeenCalled();
  });

  it.each(["image/jpeg", "image/png", "image/webp", "image/avif"])("accepts %s", async (contentType) => {
    const { context } = await setupAcademy("academy_owner");
    const result = await requestCourseImageUploadUrl(context, { contentType, fileSizeBytes: 1000 });
    expect(result.ok).toBe(true);
  });

  it("rejects image/gif (no animation use case for a course image)", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await requestCourseImageUploadUrl(context, { contentType: "image/gif", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects image/svg+xml (no sanitization pipeline)", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await requestCourseImageUploadUrl(context, { contentType: "image/svg+xml", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects a declared size over the 10 MB limit", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await requestCourseImageUploadUrl(context, { contentType: "image/png", fileSizeBytes: 50 * 1024 * 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("createCourse/updateCourse — uploaded (own) image key verification", () => {
  // `imageRef` predates the upload feature as a plain externally-hosted-URL
  // text field (see courses.ts's own `createCourseSchema.imageRef` comment)
  // and still accepts any string at face value when it ISN'T recognized as
  // the CALLER's own academy-scoped upload key — `isCourseImageKey` gates
  // re-verification on the caller's academyId, so another academy's own key
  // is treated exactly like a legacy pasted URL here (unverified, never
  // touching R2), not rejected. This is pre-existing, unchanged behavior —
  // unlike logo/book-cover/student-photo, a course image was never a
  // required, always-our-own-key field. The stored value is still harmless:
  // at render time `getCourseImageUrl` reruns the same `isCourseImageKey`
  // check against the DISPLAYING academy, so a foreign key never resolves
  // to a real signed URL for anyone — it just renders as a broken image.
  it("accepts (unverified) an uploaded key belonging to a different academy, treating it like a legacy pasted URL", async () => {
    const { context, programId } = await setupAcademy("academy_owner");
    const other = await setupAcademy("academy_owner");
    const foreignKey = getCourseImageKey({ academyId: other.academyId, extension: "png" });

    const result = await createCourse(context, validInput(programId, { imageRef: foreignKey }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.course.imageRef).toBe(foreignKey);
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  it("rejects and deletes the object when the real bytes don't match the declared content-type (spoofed MIME)", async () => {
    const { context, academyId, programId } = await setupAcademy("academy_owner");
    const key = getCourseImageKey({ academyId, extension: "png" });
    getObjectPrefixMock.mockResolvedValueOnce({ ok: true, exists: true, bytes: INVALID_SIGNATURE_BYTES });

    const result = await createCourse(context, validInput(programId, { imageRef: key }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(deleteObjectMock).toHaveBeenCalledWith(key);
  });

  it("rejects and deletes an empty (0-byte) uploaded object", async () => {
    const { context, academyId, programId } = await setupAcademy("academy_owner");
    const key = getCourseImageKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValueOnce({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 0 } });

    const result = await createCourse(context, validInput(programId, { imageRef: key }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(deleteObjectMock).toHaveBeenCalledWith(key);
  });

  it("persists a verified uploaded key as the course's imageRef", async () => {
    const { context, academyId, programId } = await setupAcademy("academy_owner");
    const key = getCourseImageKey({ academyId, extension: "png" });

    const result = await createCourse(context, validInput(programId, { imageRef: key }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.course.imageRef).toBe(key);
  });

  it("a legacy externally-hosted-URL imageRef is accepted at face value, without ever touching R2", async () => {
    const { context, programId } = await setupAcademy("academy_owner");
    const result = await createCourse(context, validInput(programId, { imageRef: "https://example.com/legacy.jpg" }));
    expect(result.ok).toBe(true);
    expect(headObjectMock).not.toHaveBeenCalled();
  });
});

describe("listCourseEnrollments", () => {
  it("returns not_found for a course in another academy", async () => {
    const other = await setupAcademy("academy_owner");
    const otherCourse = await createCourse(other.context, validInput(other.programId));
    expect(otherCourse.ok).toBe(true);
    if (!otherCourse.ok) return;

    const { context } = await setupAcademy("academy_owner");
    const result = await listCourseEnrollments(context, otherCourse.course.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("returns an empty list for a course with no batches/enrollments yet", async () => {
    const { context, programId } = await setupAcademy("academy_owner");
    const created = await createCourse(context, validInput(programId));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await listCourseEnrollments(context, created.course.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.enrollments).toEqual([]);
  });
});

describe("getCourseDeletionEligibility / deleteCourse", () => {
  it("an unused course (zero batches) is eligible and deletes, freeing the plan allowance", async () => {
    const { context, programId } = await setupAcademy("academy_owner");
    const created = await createCourse(context, validInput(programId, { name: "Unused Course" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const eligibility = await getCourseDeletionEligibility(context, created.course.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(true);
      expect(eligibility.eligibility.reasons).toEqual([]);
    }

    const deleted = await deleteCourse(context, created.course.id, "Unused Course");
    expect(deleted.ok).toBe(true);

    const stillThere = await getCourse(context, created.course.id);
    expect(stillThere.ok).toBe(false);
    if (!stillThere.ok) expect(stillThere.error.code).toBe("not_found");
  });

  it("a course with a batch attached is blocked from deletion, and nothing is deleted", async () => {
    const { academyId, context, programId } = await setupAcademy("academy_owner");
    const created = await createCourse(context, validInput(programId, { name: "Course With Batch" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const branchId = await insertBranchDirect(academyId);
    await insertBatchDirect(academyId, branchId, created.course.id);

    const eligibility = await getCourseDeletionEligibility(context, created.course.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.batchCount).toBe(1);
    }

    const deleted = await deleteCourse(context, created.course.id, "Course With Batch");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");

    const stillThere = await getCourse(context, created.course.id);
    expect(stillThere.ok).toBe(true);
  });

  it("deleting an eligible course frees its plan course-allowance slot immediately", async () => {
    const { context, programId } = await setupAcademy("academy_owner", 1);
    const first = await createCourse(context, validInput(programId, { name: "First Course" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Plan limit is 1 — a second course must be refused while the first exists.
    const blocked = await createCourse(context, validInput(programId, { name: "Second Course" }));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("allowance");

    const deleted = await deleteCourse(context, first.course.id, "First Course");
    expect(deleted.ok).toBe(true);

    // Deleting the row (not just archiving) frees the slot with no separate
    // bookkeeping — countCourses is a live COUNT(status='active') query.
    const allowed = await createCourse(context, validInput(programId, { name: "Third Course" }));
    expect(allowed.ok).toBe(true);
  });

  it("rejects a wrong confirmation name, and nothing is deleted", async () => {
    const { context, programId } = await setupAcademy("academy_owner");
    const created = await createCourse(context, validInput(programId, { name: "Type Me Exactly" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await deleteCourse(context, created.course.id, "Wrong Name");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const stillThere = await getCourse(context, created.course.id);
    expect(stillThere.ok).toBe(true);
  });

  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const owner = await setupAcademy("academy_owner");
      const created = await createCourse(owner.context, validInput(owner.programId));
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const actingUserId = await createUser();
      await addMembership(actingUserId, owner.academyId, role);
      const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

      const result = await deleteCourse(actingContext, created.course.id, created.course.name);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("never deletes another academy's course (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherCreated = await createCourse(other.context, validInput(other.programId, { name: "Other Academy Course" }));
    expect(otherCreated.ok).toBe(true);
    if (!otherCreated.ok) return;

    const { context } = await setupAcademy("academy_owner");
    const eligibility = await getCourseDeletionEligibility(context, otherCreated.course.id);
    expect(eligibility.ok).toBe(false);
    if (!eligibility.ok) expect(eligibility.error.code).toBe("not_found");

    const result = await deleteCourse(context, otherCreated.course.id, "Other Academy Course");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const stillThere = await getCourse(other.context, otherCreated.course.id);
    expect(stillThere.ok).toBe(true);
  });

  it("writes an audit row before deleting, and the audit row survives the deletion", async () => {
    const { academyId, userId, context, programId } = await setupAcademy("academy_owner");
    const created = await createCourse(context, validInput(programId, { name: "Audited Deletion" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await deleteCourse(context, created.course.id, "Audited Deletion");
    expect(result.ok).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.course.id), eq(auditLogs.action, "deleteCourse")));
    expect(audit?.action).toBe("deleteCourse");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("race condition: a batch created after the eligibility check still blocks the delete transaction", async () => {
    const { academyId, context, programId } = await setupAcademy("academy_owner");
    const created = await createCourse(context, validInput(programId, { name: "Race Condition Course" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const eligibility = await getCourseDeletionEligibility(context, created.course.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) expect(eligibility.eligibility.eligible).toBe(true);

    // Simulates a concurrent createBatch landing between the UI's
    // eligibility preview and the actual delete call.
    const branchId = await insertBranchDirect(academyId);
    await insertBatchDirect(academyId, branchId, created.course.id);

    const result = await deleteCourse(context, created.course.id, "Race Condition Course");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");

    const stillThere = await getCourse(context, created.course.id);
    expect(stillThere.ok).toBe(true);
  });
});
