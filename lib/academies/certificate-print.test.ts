import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batches,
  branches,
  certificates,
  courses,
  programs,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { getCertificatePrintData } from "./certificate-print";

/**
 * Focused regression test for the academy-logo bug fixed in this change:
 * `getCertificatePrintData` previously returned the RAW `academies.logoRef`
 * R2 object key as `academy.logoRef`, and the print/PDF views rendered it
 * directly as an `<img src>`/`<Image src>` — which resolves as a relative
 * path against the app's own origin (or fails entirely for the PDF
 * renderer) rather than ever reaching R2. Fixed by resolving it through the
 * same `getAcademyLogoUrl` helper every other print view already uses
 * (book-sale-receipt-print.ts, timetable-print.ts, app/academy/settings),
 * exposed as `academy.logoUrl` (a real signed URL, or null).
 *
 * A separate, small file (not added to lib/academies/certificates.test.ts's
 * existing `getCertificatePrintData` describe block) specifically so this
 * is the only file in the suite that mocks `@/lib/storage/client` — that
 * 1000+-line file's many other tests never touch storage and must not be
 * put at risk by a module-level mock they don't need.
 */
vi.mock("@/lib/storage/client", () => ({
  getUploadUrl: vi.fn(),
  deleteObject: vi.fn(),
  getDownloadUrl: vi.fn(),
  headObject: vi.fn(),
}));
import { getDownloadUrl } from "@/lib/storage/client";
const getDownloadUrlMock = vi.mocked(getDownloadUrl);

beforeEach(() => {
  getDownloadUrlMock.mockReset();
});

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `certificate-print-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Certificate Print Test Plan ${randomUUID()}`,
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
    .values({ name: `Certificate Print Test Academy ${randomUUID()}`, slug: `cert-print-test-${randomUUID()}`, defaultCurrency: "USD", createdBy: creatorUserId })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(userId: string, academyId: string, role: AcademyRole): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

async function setupCertificateFixture(): Promise<{ academyId: string; certificateId: string; context: AuthContext }> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan();
  await db.insert(academySubscriptions).values({ academyId, planId, status: "active", endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), createdBy: creatorUserId });

  const [branch] = await db.insert(branches).values({ academyId, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` }).returning({ id: branches.id });
  const [program] = await db.insert(programs).values({ academyId, name: `Program ${randomUUID()}` }).returning({ id: programs.id });
  const [course] = await db.insert(courses).values({ academyId, programId: program.id, name: `Course ${randomUUID()}` }).returning({ id: courses.id });
  const [batch] = await db
    .insert(batches)
    .values({ academyId, branchId: branch.id, courseId: course.id, name: `Batch ${randomUUID()}`, code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
    .returning({ id: batches.id });
  const [student] = await db
    .insert(students)
    .values({ academyId, branchId: branch.id, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Test Student", createdBy: creatorUserId })
    .returning({ id: students.id });

  // Inserted directly (not via issueCertificate) — eligibility/grade logic
  // is entirely unrelated to this file's own logo-resolution focus.
  const [certificate] = await db
    .insert(certificates)
    .values({ academyId, studentId: student.id, batchId: batch.id, certificateCode: `CERT-${randomUUID().slice(0, 8)}`, issuedBy: creatorUserId })
    .returning({ id: certificates.id });

  const ownerUserId = await createUser();
  await addMembership(ownerUserId, academyId, "academy_owner");

  return { academyId, certificateId: certificate.id, context: { userId: ownerUserId, branchIds: [], academyWide: false } };
}

afterAll(async () => {
  await db.delete(auditLogs).where(or(...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)), ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id))));
  for (const academyId of createdAcademyIds) {
    await db.delete(certificates).where(eq(certificates.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
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
});

describe("getCertificatePrintData — academy logo resolution", () => {
  it("resolves academy.logoUrl to a real signed URL, never the raw R2 key, when a logo is set", async () => {
    const { academyId, certificateId, context } = await setupCertificateFixture();
    const fakeKey = `academies/${academyId}/logos/${randomUUID()}.png`;
    await db.update(academies).set({ logoRef: fakeKey }).where(eq(academies.id, academyId));

    getDownloadUrlMock.mockResolvedValue({ ok: true, downloadUrl: "https://r2.example.test/signed-logo-url?sig=abc" });

    const result = await getCertificatePrintData(context, certificateId, "https://app.example.com");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.academy.logoUrl).toBe("https://r2.example.test/signed-logo-url?sig=abc");
    // Never the raw key — that was the exact bug (a non-URL value rendered
    // directly as an <img src>/<Image src>, which 404s as a relative path).
    expect(result.data.academy.logoUrl).not.toBe(fakeKey);
    expect(getDownloadUrlMock).toHaveBeenCalledWith({ key: fakeKey });
  });

  it("academy.logoUrl is null when no logo is configured — never attempts a resolution", async () => {
    const { certificateId, context } = await setupCertificateFixture();

    const result = await getCertificatePrintData(context, certificateId, "https://app.example.com");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.academy.logoUrl).toBeNull();
    expect(getDownloadUrlMock).not.toHaveBeenCalled();
  });

  it("academy.logoUrl is null (not a broken value) if the R2 download URL cannot be generated", async () => {
    const { academyId, certificateId, context } = await setupCertificateFixture();
    const fakeKey = `academies/${academyId}/logos/${randomUUID()}.png`;
    await db.update(academies).set({ logoRef: fakeKey }).where(eq(academies.id, academyId));

    getDownloadUrlMock.mockResolvedValue({ ok: false, error: "File storage is not configured." });

    const result = await getCertificatePrintData(context, certificateId, "https://app.example.com");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.academy.logoUrl).toBeNull();
  });
});
