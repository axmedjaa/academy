import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { academies, academyMemberships, academySubscriptions, auditLogs, subscriptionPlans, users } from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";

// Real Cloudflare R2 is never called from the test suite — mocking this
// one boundary (the same shared module every academy-logo action goes
// through) lets these tests verify keys/authorization/audit/DB behavior
// without any real network call, matching every other provider-boundary
// test file's style in this codebase (lib/email/client.test.ts,
// lib/storage/client.test.ts).
vi.mock("@/lib/storage/client", () => ({
  getUploadUrl: vi.fn(),
  getDownloadUrl: vi.fn(),
  deleteObject: vi.fn(),
  headObject: vi.fn(),
}));

import { deleteObject, getUploadUrl, headObject } from "@/lib/storage/client";
import {
  MAX_LOGO_SIZE_BYTES,
  confirmAcademyLogoUpload,
  getAcademyLogoUrl,
  removeAcademyLogo,
  requestAcademyLogoUploadUrl,
} from "./academy-logo";
import { getAcademyLogoKey } from "@/lib/storage/keys";

const getUploadUrlMock = vi.mocked(getUploadUrl);
const headObjectMock = vi.mocked(headObject);
const deleteObjectMock = vi.mocked(deleteObject);

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `academy-logo-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Academy Logo Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 3,
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
      name: `Academy Logo Test Academy ${randomUUID()}`,
      slug: `academy-logo-test-${randomUUID()}`,
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

async function auditRowsFor(academyId: string, action: string) {
  return db.select().from(auditLogs).where(and(eq(auditLogs.entityId, academyId), eq(auditLogs.action, action)));
}

beforeEach(() => {
  getUploadUrlMock.mockReset();
  headObjectMock.mockReset();
  deleteObjectMock.mockReset();
  getUploadUrlMock.mockResolvedValue({ ok: true, uploadUrl: "https://r2.example/signed-put", expiresInSeconds: 300 });
  deleteObjectMock.mockResolvedValue({ ok: true });
});

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

describe("requestAcademyLogoUploadUrl — authorization", () => {
  it("refuses a role without the academy.settings permission (finance_officer)", async () => {
    const { context } = await setupAcademy("finance_officer");
    const result = await requestAcademyLogoUploadUrl(context, { contentType: "image/png", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(getUploadUrlMock).not.toHaveBeenCalled();
  });

  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "allows %s to request an upload URL",
    async (role) => {
      const { context } = await setupAcademy(role);
      const result = await requestAcademyLogoUploadUrl(context, { contentType: "image/png", fileSizeBytes: 1000 });
      expect(result.ok).toBe(true);
    },
  );

  it("scopes the generated key to the caller's own academy — there is no way to request one for a different academy", async () => {
    const a = await setupAcademy("academy_owner");
    const b = await setupAcademy("academy_owner");

    const resultA = await requestAcademyLogoUploadUrl(a.context, { contentType: "image/png", fileSizeBytes: 1000 });
    const resultB = await requestAcademyLogoUploadUrl(b.context, { contentType: "image/png", fileSizeBytes: 1000 });
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (resultA.ok && resultB.ok) {
      expect(resultA.key.startsWith(`academies/${a.academyId}/logos/`)).toBe(true);
      expect(resultB.key.startsWith(`academies/${b.academyId}/logos/`)).toBe(true);
      expect(resultA.key).not.toBe(resultB.key);
    }
  });
});

describe("requestAcademyLogoUploadUrl — file validation", () => {
  it.each(["image/jpeg", "image/png", "image/webp"])("accepts %s", async (contentType) => {
    const { context } = await setupAcademy("academy_owner");
    const result = await requestAcademyLogoUploadUrl(context, { contentType, fileSizeBytes: 1000 });
    expect(result.ok).toBe(true);
  });

  it("rejects application/pdf", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await requestAcademyLogoUploadUrl(context, { contentType: "application/pdf", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects image/svg+xml", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await requestAcademyLogoUploadUrl(context, { contentType: "image/svg+xml", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects a declared size over the 5 MB limit", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await requestAcademyLogoUploadUrl(context, {
      contentType: "image/png",
      fileSizeBytes: MAX_LOGO_SIZE_BYTES + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("confirmAcademyLogoUpload — tenant isolation on the object key", () => {
  it("rejects a key belonging to a different academy, without ever calling headObject", async () => {
    const a = await setupAcademy("academy_owner");
    const b = await setupAcademy("academy_owner");
    const keyForB = getAcademyLogoKey({ academyId: b.academyId, extension: "png" });

    const result = await confirmAcademyLogoUpload(a.context, { key: keyForB });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary, non-key-shaped string", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await confirmAcademyLogoUpload(context, { key: "../../../etc/passwd" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("confirmAcademyLogoUpload — server-verified object validation", () => {
  it("rejects when the object doesn't actually exist in R2", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const key = getAcademyLogoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: false });

    const result = await confirmAcademyLogoUpload(context, { key });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects and deletes the object when the REAL content-type isn't allowed (client lied at request time)", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const key = getAcademyLogoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "application/pdf", contentLength: 1000 } });

    const result = await confirmAcademyLogoUpload(context, { key });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(deleteObjectMock).toHaveBeenCalledWith(key);
  });

  it("rejects and deletes the object when the REAL size exceeds the limit", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const key = getAcademyLogoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({
      ok: true,
      exists: true,
      info: { contentType: "image/png", contentLength: MAX_LOGO_SIZE_BYTES + 1 },
    });

    const result = await confirmAcademyLogoUpload(context, { key });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(deleteObjectMock).toHaveBeenCalledWith(key);
  });

  it("does not touch the database when confirmation fails — the old logo remains authoritative", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const oldKey = "academies/pre-existing/logos/old.png";
    await db.update(academies).set({ logoRef: oldKey }).where(eq(academies.id, academyId));

    const badKey = getAcademyLogoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: false });
    const result = await confirmAcademyLogoUpload(context, { key: badKey });
    expect(result.ok).toBe(false);

    const [row] = await db.select({ logoRef: academies.logoRef }).from(academies).where(eq(academies.id, academyId));
    expect(row?.logoRef).toBe(oldKey);
  });
});

describe("confirmAcademyLogoUpload — success and replacement", () => {
  it("updates logoRef and audits 'uploadAcademyLogo' for a first-time upload (no previous logo)", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const key = getAcademyLogoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });

    const result = await confirmAcademyLogoUpload(context, { key });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.logoRef).toBe(key);

    const [row] = await db.select({ logoRef: academies.logoRef }).from(academies).where(eq(academies.id, academyId));
    expect(row?.logoRef).toBe(key);

    const [audit] = await auditRowsFor(academyId, "uploadAcademyLogo");
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(userId);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("audits 'replaceAcademyLogo' (not 'uploadAcademyLogo') and deletes the old object when a logo already existed", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const oldKey = "academies/pre-existing/logos/old.png";
    await db.update(academies).set({ logoRef: oldKey }).where(eq(academies.id, academyId));

    const newKey = getAcademyLogoKey({ academyId, extension: "webp" });
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/webp", contentLength: 2000 } });

    const result = await confirmAcademyLogoUpload(context, { key: newKey });
    expect(result.ok).toBe(true);

    const [row] = await db.select({ logoRef: academies.logoRef }).from(academies).where(eq(academies.id, academyId));
    expect(row?.logoRef).toBe(newKey);

    const [audit] = await auditRowsFor(academyId, "replaceAcademyLogo");
    expect(audit).toBeDefined();
    expect(deleteObjectMock).toHaveBeenCalledWith(oldKey);
  });

  it("keeps the new logo authoritative even if deleting the old object fails", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const oldKey = "academies/pre-existing/logos/old.png";
    await db.update(academies).set({ logoRef: oldKey }).where(eq(academies.id, academyId));
    deleteObjectMock.mockResolvedValue({ ok: false, error: "boom" });

    const newKey = getAcademyLogoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });

    const result = await confirmAcademyLogoUpload(context, { key: newKey });
    expect(result.ok).toBe(true);

    const [row] = await db.select({ logoRef: academies.logoRef }).from(academies).where(eq(academies.id, academyId));
    expect(row?.logoRef).toBe(newKey);
  });
});

describe("removeAcademyLogo", () => {
  it("refuses a role without the academy.settings permission", async () => {
    const { academyId, context } = await setupAcademy("trainer");
    await db.update(academies).set({ logoRef: "academies/x/logos/y.png" }).where(eq(academies.id, academyId));

    const result = await removeAcademyLogo(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");

    const [row] = await db.select({ logoRef: academies.logoRef }).from(academies).where(eq(academies.id, academyId));
    expect(row?.logoRef).toBe("academies/x/logos/y.png");
  });

  it("authorized user removes the logo: deletes the R2 object, clears logoRef, and audits it", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const key = "academies/x/logos/y.png";
    await db.update(academies).set({ logoRef: key }).where(eq(academies.id, academyId));

    const result = await removeAcademyLogo(context);
    expect(result.ok).toBe(true);
    expect(deleteObjectMock).toHaveBeenCalledWith(key);

    const [row] = await db.select({ logoRef: academies.logoRef }).from(academies).where(eq(academies.id, academyId));
    expect(row?.logoRef).toBeNull();

    const [audit] = await auditRowsFor(academyId, "removeAcademyLogo");
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(userId);
  });

  it("is a safe no-op when there is no logo to remove", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await removeAcademyLogo(context);
    expect(result.ok).toBe(true);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("still clears the database reference when the R2 object is already missing", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    await db.update(academies).set({ logoRef: "academies/x/logos/y.png" }).where(eq(academies.id, academyId));
    deleteObjectMock.mockResolvedValue({ ok: false, error: "not found" });

    const result = await removeAcademyLogo(context);
    expect(result.ok).toBe(true);

    const [row] = await db.select({ logoRef: academies.logoRef }).from(academies).where(eq(academies.id, academyId));
    expect(row?.logoRef).toBeNull();
  });

  it("never touches a different academy's logo", async () => {
    const a = await setupAcademy("academy_owner");
    const b = await setupAcademy("academy_owner");
    await db.update(academies).set({ logoRef: "academies/a/logos/1.png" }).where(eq(academies.id, a.academyId));
    await db.update(academies).set({ logoRef: "academies/b/logos/2.png" }).where(eq(academies.id, b.academyId));

    await removeAcademyLogo(a.context);

    const [rowA] = await db.select({ logoRef: academies.logoRef }).from(academies).where(eq(academies.id, a.academyId));
    const [rowB] = await db.select({ logoRef: academies.logoRef }).from(academies).where(eq(academies.id, b.academyId));
    expect(rowA?.logoRef).toBeNull();
    expect(rowB?.logoRef).toBe("academies/b/logos/2.png");
  });
});

describe("getAcademyLogoUrl", () => {
  it("returns null for no logo, without calling the storage layer", async () => {
    const { getDownloadUrl } = await import("@/lib/storage/client");
    vi.mocked(getDownloadUrl).mockClear();
    const url = await getAcademyLogoUrl(null);
    expect(url).toBeNull();
    expect(getDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns the signed URL for a real key", async () => {
    const { getDownloadUrl } = await import("@/lib/storage/client");
    vi.mocked(getDownloadUrl).mockResolvedValue({ ok: true, downloadUrl: "https://r2.example/signed-get" });
    const url = await getAcademyLogoUrl("academies/x/logos/y.png");
    expect(url).toBe("https://r2.example/signed-get");
  });

  it("returns null (never throws) when the storage layer fails", async () => {
    const { getDownloadUrl } = await import("@/lib/storage/client");
    vi.mocked(getDownloadUrl).mockResolvedValue({ ok: false, error: "boom" });
    const url = await getAcademyLogoUrl("academies/x/logos/y.png");
    expect(url).toBeNull();
  });
});

describe("audit payload safety", () => {
  it("never includes a presigned URL or any storage credential in the audit before/after", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const key = getAcademyLogoKey({ academyId, extension: "png" });
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });

    await confirmAcademyLogoUpload(context, { key });

    const [audit] = await auditRowsFor(academyId, "uploadAcademyLogo");
    const serialized = JSON.stringify({ before: audit.before, after: audit.after });
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toContain("AccessKey");
    expect(serialized).not.toContain("Secret");
  });
});
